
import { useEffect, useState } from "react";
import "./App.css";

const API = "http://localhost:3000";
const API_KEY = import.meta.env.VITE_API_KEY;

export default function App() {
  const [slots, setSlots] = useState([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [booking, setBooking] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadSlots() {
    try {
      const res = await fetch(`${API}/slots`, {
        headers: { "X-API-Key": API_KEY },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSlots(data.slots || []);
    } catch (err) {
      setMessage(err.message || "Unable to load slots");
    }
  }

  useEffect(() => {
    loadSlots();
  }, []);

  async function bookAppointment(e) {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const res = await fetch(`${API}/bookings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          slot_id: selected,
          name,
          email,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setBooking(data);
      await loadSlots();
    } catch (err) {
      setMessage(err.message || "Booking failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <header>
        <div className="brand">✚ Koya Clinic</div>
        <span className="eyebrow">YOUR HEALTH, OUR PRIORITY</span>
        <h1>Book your next appointment.</h1>
        <p>Choose a convenient time and confirm your visit in minutes.</p>
      </header>

      <div className="layout">
        <section className="panel">
          <h2>1. Select an appointment</h2>
          <p>Available appointment times</p>

          <div className="slots">
            {slots.filter((slot) => new Date(slot.start) > new Date()).length === 0 && (
              <p>No upcoming slots are available.</p>
            )}

            {slots
              .filter((slot) => new Date(slot.start) > new Date())
              .map((slot) => (
                <button
                  type="button"
                  key={slot.id}
                  className={`slot ${selected === slot.id ? "active" : ""}`}
                  onClick={() => setSelected(slot.id)}
                >
                  <strong>{slot.provider}</strong>
                  <span>{new Date(slot.start).toLocaleString()}</span>
                </button>
              ))}
          </div>
        </section>

        <section className="panel">
          <h2>2. Your details</h2>
          <p>Complete your appointment request</p>

          <form onSubmit={bookAppointment}>
            <label>Full name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your full name"
            />

            <label>Email address</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />

            <button className="submit" disabled={!selected || loading}>
              {loading ? "Booking..." : "Confirm appointment"}
            </button>
          </form>

          {message && <p className="error">{message}</p>}

          {booking && (
            <div className="confirmation">
              <h3>✓ Booking confirmed!</h3>
              <p>Patient: {booking.name}</p>
              <p>Email: {booking.email}</p>
              <p>Booking ID: {booking.id}</p>
              <p>Status: {booking.status}</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
