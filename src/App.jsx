import { useState, useEffect } from "react";
import { db, auth } from "./firebase";
import {
  doc,
  setDoc,
  getDoc,
  collection,
  addDoc,
  onSnapshot,
  updateDoc,
} from "firebase/firestore";

export default function App() {
  const [mode, setMode] = useState("home"); // "home" | "room"
  const [question, setQuestion] = useState("");
  const [optionsInput, setOptionsInput] = useState(""); // campo para opciones dinámicas
  const [joinCode, setJoinCode] = useState("");
  const [code, setCode] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [adminUid, setAdminUid] = useState(null);
  const [adminName, setAdminName] = useState(null);
  const [userName, setUserName] = useState(localStorage.getItem("userName") || "");

  /* ----------------------- helpers ----------------------- */
  const handleSetName = () => {
    if (!userName.trim()) return alert("Escribe tu nombre");
    localStorage.setItem("userName", userName);
    alert("Nombre guardado ✅");
  };

  // transformar el input en array de opciones
  const parseOptions = (raw) => {
    const arr = (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return arr.length ? arr : ["Sí", "No"];
  };

  /* ----------------------- lógica ----------------------- */
  const createRoom = async () => {
    if (!question.trim()) return alert("Escribe una pregunta");
    if (!userName.trim()) return alert("Primero guarda tu nombre");

    const newCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    const user = auth.currentUser;

    await setDoc(doc(db, "rooms", newCode), {
      createdAt: Date.now(),
      adminUid: user ? user.uid : null,
      adminName: userName,
    });

    const options = parseOptions(optionsInput);
    const votesObj = Object.fromEntries(options.map((o) => [o, 0]));

    await addDoc(collection(db, "rooms", newCode, "questions"), {
      question,
      options,
      votes: votesObj,
      closed: false,
      voters: [],
    });

    setCode(newCode);
    setMode("room");
    setQuestion("");
    setOptionsInput("");
  };

  const joinRoom = async () => {
    if (!joinCode.trim()) return alert("Escribe un código");
    const ref = doc(db, "rooms", joinCode.toUpperCase());
    const snap = await getDoc(ref);
    if (!snap.exists()) return alert("Sala no encontrada");
    setCode(joinCode.toUpperCase());
    setMode("room");
  };

  useEffect(() => {
    if (!code) return;

    const unsubRoom = onSnapshot(doc(db, "rooms", code), (snap) => {
      if (snap.exists()) {
        setAdminUid(snap.data().adminUid);
        setAdminName(snap.data().adminName);
      }
    });

    const unsubQs = onSnapshot(collection(db, "rooms", code, "questions"), (snap) => {
      const qs = [];
      snap.forEach((d) => qs.push({ id: d.id, ...d.data() }));
      setQuestions(qs);
    });

    return () => {
      unsubRoom();
      unsubQs();
    };
  }, [code]);

  const addQuestion = async () => {
    if (!question.trim()) return alert("Escribe una pregunta");

    const options = parseOptions(optionsInput);
    const votesObj = Object.fromEntries(options.map((o) => [o, 0]));

    await addDoc(collection(db, "rooms", code, "questions"), {
      question,
      options,
      votes: votesObj,
      closed: false,
      voters: [],
    });

    setQuestion("");
    setOptionsInput("");
  };

  const votar = async (qId, opcion, currentVotes, closed, voters = []) => {
    if (closed) return alert("Pregunta cerrada");
    const user = auth.currentUser;
    if (!user) return alert("No estás autenticado");

    const name = localStorage.getItem("userName") || "Anónimo";
    if (voters.some((v) => v.uid === user.uid)) return alert("Ya votaste en esta pregunta");

    await updateDoc(doc(db, "rooms", code, "questions", qId), {
      [`votes.${opcion}`]: currentVotes[opcion] + 1,
      voters: [...voters, { uid: user.uid, name, choice: opcion }],
    });
  };

  const cerrarPregunta = async (qId) => {
    await updateDoc(doc(db, "rooms", code, "questions", qId), { closed: true });
  };

  /* ----------------------- views ----------------------- */
  if (mode === "room") {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        {/* Header */}
        <header className="bg-primary text-white">
          <div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
            <h1 className="text-xl font-bold">
              🗳️ Sala #{code}
              {auth.currentUser?.uid === adminUid
                ? ` — Hola, ${userName} (Moderador)`
                : ` — Hola, ${userName}`}
            </h1>
            <button
              className="text-sm underline decoration-white/60 hover:decoration-white"
              onClick={() => setMode("home")}
            >
              Salir
            </button>
          </div>
        </header>

        {/* Main */}
        <main className="flex-1 mx-auto max-w-5xl px-4 py-8 space-y-6">
          {/* Crear pregunta (admin) */}
          {auth.currentUser?.uid === adminUid && (
            <section className="rounded-xl border border-black/5 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-medium text-primary mb-2">Nueva pregunta</h2>
              <div className="flex flex-col gap-3 max-w-2xl">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Escribe la pregunta"
                  className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
                <input
                  value={optionsInput}
                  onChange={(e) => setOptionsInput(e.target.value)}
                  placeholder="Opciones separadas por comas (ej: A favor,En contra,Abstención)"
                  className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  onClick={addQuestion}
                  className="rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light"
                >
                  Agregar
                </button>
              </div>
            </section>
          )}

          {/* Lista preguntas */}
          <section className="space-y-4">
            {questions.length === 0 && (
              <p className="text-black/60">No hay preguntas aún.</p>
            )}

            {questions.map((q) => {
              const total = Object.values(q.votes).reduce((a, b) => a + b, 0);
              return (
                <div key={q.id} className="rounded-2xl border border-black/5 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <h3 className="text-lg font-semibold">
                      {q.question}{" "}
                      {q.closed && (
                        <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                          Cerrada
                        </span>
                      )}
                    </h3>
                    {auth.currentUser?.uid === adminUid && !q.closed && (
                      <button
                        onClick={() => cerrarPregunta(q.id)}
                        className="text-sm text-secondary hover:underline"
                      >
                        🔒 Cerrar
                      </button>
                    )}
                  </div>

                  <p className="mt-2 text-sm text-black/70">
                    Total votos: <b>{total}</b>
                  </p>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                    {q.options.map((op) => (
                      <button
                        key={op}
                        onClick={() =>
                          votar(q.id, op, q.votes, q.closed, q.voters || [])
                        }
                        className="rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light disabled:opacity-50"
                        disabled={q.closed}
                      >
                        {op} ({q.votes[op]})
                      </button>
                    ))}
                  </div>

                  {q.voters && q.voters.length > 0 && (
                    <div className="mt-4">
                      <div className="text-sm font-medium text-black/70 mb-1">Votantes</div>
                      <ul className="grid gap-1 sm:grid-cols-2 md:grid-cols-3">
                        {q.voters.map((v, i) => (
                          <li
                            key={i}
                            className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-black/80"
                          >
                            <span className="font-medium">{v.name}</span>{" "}
                            <span className="text-black/50">→ {v.choice}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </main>

        {/* Footer */}
        <footer className="bg-primary-dark text-white mt-auto">
          <div className="mx-auto max-w-5xl px-4 py-3 text-center text-sm opacity-90">
            © {new Date().getFullYear()} Mesas de Votación — Votaciones en tiempo real.
          </div>
        </footer>
      </div>
    );
  }

  /* ----------------------- HOME ----------------------- */
  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="bg-primary text-white">
        <div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">🗳️</span>
            <h1 className="text-xl font-bold">Mesas de Votación</h1>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 mx-auto max-w-5xl px-4 py-10 space-y-8">
        <h2 className="text-3xl md:text-4xl font-extrabold text-primary text-center">
          Crea una sala o únete con un código
        </h2>

        {/* Nombre del usuario */}
        <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm max-w-lg mx-auto">
          <h3 className="text-lg font-semibold text-primary mb-4">Tu nombre</h3>
          <div className="flex gap-3">
            <input
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="Escribe tu nombre"
              className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              onClick={handleSetName}
              className="rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light"
            >
              Guardar
            </button>
          </div>
          <p className="mt-2 text-xs text-black/50">
            Tu nombre se usará para mostrar quién vota y, si creas una sala, como moderador.
          </p>
        </section>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Crear sala */}
          <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-primary mb-4">Crear sala</h3>
            <div className="flex flex-col gap-3">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Pregunta inicial"
                className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
              />
              <input
                value={optionsInput}
                onChange={(e) => setOptionsInput(e.target.value)}
                placeholder="Opciones separadas por comas (ej: Sí,No,Abstención)"
                className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                onClick={createRoom}
                className="rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light"
              >
                Crear
              </button>
            </div>
            <p className="mt-2 text-xs text-black/50">
              Escribe las opciones de respuesta separadas por comas.
              Ejemplo: <i>Sí,No,Abstención</i>.
              Si lo dejas vacío, se usarán las opciones clásicas <b>Sí / No</b>.
            </p>
          </section>

          {/* Unirse a sala */}
          {/* Unirse a sala */}
          <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-primary mb-4">Unirse a sala</h3>
            <div className="flex gap-3">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="CÓDIGO (ej: ABC12)"
                className="flex-1 rounded-lg border border-black/10 px-3 py-2 uppercase tracking-wider outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                onClick={joinRoom}
                disabled={!userName.trim()} // 🚨 Bloqueamos si no hay nombre
                className={`rounded-lg px-4 py-2 font-medium text-white ${userName.trim()
                    ? "bg-secondary hover:opacity-90"
                    : "bg-gray-400 cursor-not-allowed"
                  }`}
              >
                Entrar
              </button>
            </div>
            <p className="mt-2 text-xs text-black/50">
              Solo podrás entrar si antes guardaste tu nombre.
            </p>
          </section>

        </div>
      </main>

      {/* Footer */}
      <footer className="bg-primary-dark text-white mt-auto">
        <div className="mx-auto max-w-5xl px-4 py-3 text-center text-sm opacity-90">
          © {new Date().getFullYear()} Mesas de Votación — Votaciones en tiempo real.
        </div>
      </footer>
    </div>
  );
}

