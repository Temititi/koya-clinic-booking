
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const pool = require("./db");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json());


// Level 2: API key authentication
app.use((req, res, next) => {
    const apiKey = req.get("X-API-Key");
  
    if (!process.env.API_KEY || apiKey !== process.env.API_KEY) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }
  
    next();
});
  

// Level 5: Track booking attempts per email.
// This works for one running server process.
const attemptsByEmail = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function checkRateLimit(email) {
  const now = Date.now();
  const previous = attemptsByEmail.get(email) || [];
  const recent = previous.filter(
    (timestamp) => now - timestamp < WINDOW_MS
  );

  if (recent.length >= MAX_ATTEMPTS) {
    attemptsByEmail.set(email, recent);

    const retryAfter = Math.max(
      1,
      Math.ceil((WINDOW_MS - (now - recent[0])) / 1000)
    );

    return { allowed: false, retryAfter };
  }

  recent.push(now);
  attemptsByEmail.set(email, recent);

  return { allowed: true };
}

// Health check
app.get("/", (req, res) => {
  res.json({
    message: "Koya Clinic Booking API is running!"
  });
});

// Reset appointment slots
app.post("/reset", async (req, res) => {
  const { slots } = req.body || {};

  if (!Array.isArray(slots)) {
    return res.status(400).json({
      error: "slots must be an array"
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM slots");
    await client.query("DELETE FROM idempotency_keys");

    for (const slot of slots) {
      await client.query(
        `INSERT INTO slots (id, provider, starts_at, ends_at)
         VALUES ($1, $2, $3, $4)`,
        [slot.id, slot.provider, slot.start, slot.end]
      );
    }

    await client.query("COMMIT");

    // Reset test attempts as well
    attemptsByEmail.clear();

    return res.status(200).json({
      message: "Slots reset successfully"
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK");
    }

    console.error("Reset error:", error);

    return res.status(500).json({
      error: "Failed to reset slots"
    });
  } finally {
    if (client) client.release();
  }
});

// List appointment slots
app.get("/slots", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, provider, starts_at, ends_at
       FROM slots
       ORDER BY starts_at ASC`
    );

    const slots = result.rows.map((slot) => ({
      id: slot.id,
      provider: slot.provider,
      start: slot.starts_at,
      end: slot.ends_at
    }));

    return res.status(200).json({ slots });
  } catch (error) {
    console.error("Get slots error:", error);

    return res.status(500).json({
      error: "Failed to retrieve slots"
    });
  }
});

// Book an appointment: Levels 1–5
app.post("/bookings", async (req, res) => {
  const { slot_id, name, email } = req.body || {};
  const idempotencyKey = req.get("Idempotency-Key");

  // Level 2: Validate required fields
  if (
    typeof slot_id !== "string" ||
    !slot_id.trim() ||
    typeof name !== "string" ||
    !name.trim() ||
    typeof email !== "string" ||
    !email.trim()
  ) {
    return res.status(400).json({
      error: "slot_id, name and email are required"
    });
  }

  const cleanSlotId = slot_id.trim();
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({
      error: "Invalid email address"
    });
  }

  // Level 5: Rate-limit attempts for each email
  const limit = checkRateLimit(cleanEmail);

  if (!limit.allowed) {
    res.set("Retry-After", String(limit.retryAfter));

    return res.status(429).json({
      error: "Too many booking attempts"
    });
  }

  // Level 4: Fingerprint the normalized request
  const requestHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        slot_id: cleanSlotId,
        name: cleanName,
        email: cleanEmail
      })
    )
    .digest("hex");

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    if (idempotencyKey) {
      // Lock requests using this key across DB connections.
      // The lock lasts until COMMIT or ROLLBACK.
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1, 0)
         )`,
        [idempotencyKey]
      );

      const saved = await client.query(
        `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
         WHERE key = $1`,
        [idempotencyKey]
      );

      if (saved.rows.length > 0) {
        const previous = saved.rows[0];

        await client.query("COMMIT");

        if (previous.request_hash !== requestHash) {
          return res.status(422).json({
            error: "Idempotency-Key reused with a different body"
          });
        }

        return res
          .status(previous.response_status)
          .json(previous.response_body);
      }
    }

    // Level 3: Lock the slot against concurrent bookings
    const slotResult = await client.query(
      `SELECT id, starts_at
       FROM slots
       WHERE id = $1
       FOR UPDATE`,
      [cleanSlotId]
    );

    if (slotResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "slot not found"
      });
    }

    if (
      new Date(slotResult.rows[0].starts_at) <= new Date()
    ) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "slot has already started"
      });
    }

    const existing = await client.query(
      `SELECT id
       FROM bookings
       WHERE slot_id = $1
         AND cancelled_at IS NULL`,
      [cleanSlotId]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: "slot already booked"
      });
    }

    const result = await client.query(
      `INSERT INTO bookings
         (slot_id, patient_name, patient_email)
       VALUES ($1, $2, $3)
       RETURNING id, slot_id, patient_name,
                 patient_email, created_at`,
      [cleanSlotId, cleanName, cleanEmail]
    );

    const booking = result.rows[0];

    const bookingResponse = {
      id: booking.id,
      slot_id: booking.slot_id,
      name: booking.patient_name,
      email: booking.patient_email,
      status: "confirmed",
      created_at: booking.created_at
    };

    if (idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys
           (key, request_hash, response_status, response_body)
         VALUES ($1, $2, $3, $4)`,
        [idempotencyKey, requestHash, 201, bookingResponse]
      );
    }

    await client.query("COMMIT");

    return res.status(201).json(bookingResponse);
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError);
      }
    }

    console.error("Booking error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "slot already booked"
      });
    }

    return res.status(500).json({
      error: "Failed to create booking"
    });
  } finally {
    if (client) client.release();
  }
});


// Level 1: Retrieve a booking by ID
app.get("/bookings/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, slot_id, patient_name, patient_email,
              created_at, cancelled_at
       FROM bookings
       WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "booking not found"
      });
    }

    const booking = result.rows[0];

    return res.status(200).json({
      id: booking.id,
      slot_id: booking.slot_id,
      name: booking.patient_name,
      email: booking.patient_email,
      status: booking.cancelled_at ? "cancelled" : "confirmed",
      created_at: booking.created_at
    });
  } catch (error) {
    console.error("Get booking error:", error);
    return res.status(500).json({
      error: "Failed to retrieve booking"
    });
  }
});


app.delete("/bookings/:id", async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE bookings
         SET cancelled_at = NOW()
         WHERE id = $1 AND cancelled_at IS NULL
         RETURNING id`,
        [req.params.id]
      );
  
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "booking not found or already cancelled"
        });
      }
  
      return res.status(200).json({
        message: "Booking cancelled successfully"
      });
    } catch (error) {
      console.error("Cancel booking error:", error);
      return res.status(500).json({
        error: "Failed to cancel booking"
      });
    }
});
  

app.get("/bookings", async (req, res) => {
    const email = String(req.query.email || "").trim().toLowerCase();
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 10)
    );
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Valid email is required"
      });
    }
  
    try {
      const result = await pool.query(
        `SELECT id, slot_id, patient_name, patient_email,
                created_at, cancelled_at
         FROM bookings
         WHERE LOWER(patient_email) = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [email, limit, offset]
      );
  
      const bookings = result.rows.map((booking) => ({
        id: booking.id,
        slot_id: booking.slot_id,
        name: booking.patient_name,
        email: booking.patient_email,
        status: booking.cancelled_at ? "cancelled" : "confirmed",
        created_at: booking.created_at
      }));
  
      return res.status(200).json({ bookings });
    } catch (error) {
      console.error("List bookings error:", error);
      return res.status(500).json({
        error: "Failed to retrieve bookings"
      });
    }
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
