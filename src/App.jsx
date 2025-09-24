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
  getDocs,
  deleteDoc,
} from "firebase/firestore";
import { Toaster, toast } from "react-hot-toast";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export default function App() {
  // modes: "home" | "moderator" | "voter" | "room"
  const [mode, setMode] = useState("home");

  // sala
  const [code, setCode] = useState(null);
  const [roomData, setRoomData] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [adminUid, setAdminUid] = useState(null);
  const [adminName, setAdminName] = useState(null);

  // usuario
  const [userName, setUserName] = useState(localStorage.getItem("userName") || "");
  const [isNameSaved, setIsNameSaved] = useState(!!localStorage.getItem("userName"));

  // crear/unirse
  const [question, setQuestion] = useState("");
  const [optionsInput, setOptionsInput] = useState("");
  const [joinCode, setJoinCode] = useState("");

  // parámetros moderador
  const [maxParticipants, setMaxParticipants] = useState("");
  const [quorum, setQuorum] = useState("");
  const [maxChoices, setMaxChoices] = useState(""); // ✅ número máximo de opciones seleccionables

  // para respuesta múltiple
  const [selectedOptions, setSelectedOptions] = useState({});

  /* ----------------------- helpers ----------------------- */
  const handleSetName = () => {
    if (!userName.trim()) return toast.error("⚠️ Escribe tu nombre");
    localStorage.setItem("userName", userName);
    setIsNameSaved(true);
    toast.success("✅ Nombre guardado");
  };

  const parseOptions = (raw) => {
    const arr = (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return arr.length ? arr : ["Sí", "No"];
  };

  const generarPDF = (pregunta) => {
    const pdf = new jsPDF();
    const fecha = new Date().toLocaleString();

    pdf.text(`Resultados de votación`, 14, 14);
    pdf.text(`Sala: ${code}`, 14, 22);
    pdf.text(`Fecha: ${fecha}`, 14, 30);
    pdf.text(`Pregunta: ${pregunta.question}`, 14, 40);

    autoTable(pdf, {
      startY: 48,
      head: [["Opción", "Votos"]],
      body: pregunta.options.map((o) => [o, String(pregunta.votes[o] || 0)]),
      styles: { fontSize: 11 },
    });

    const voters = pregunta.voters || [];
    if (voters.length) {
      autoTable(pdf, {
        startY: pdf.lastAutoTable.finalY + 8,
        head: [["Votantes"]],
        body: voters.map((v) => [v.name || "Anónimo"]),
        styles: { fontSize: 10 },
      });
    }

    pdf.save(`votacion_${pregunta.id}.pdf`);
  };

  const expulsarParticipante = (uid, name) => {
    if (!auth.currentUser || auth.currentUser.uid !== adminUid) {
      return toast.error("🚫 Solo el moderador puede expulsar");
    }

    toast((t) => (
      <div className="flex flex-col gap-2">
        <p className="text-sm">¿Expulsar a <b>{name}</b>?</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={async () => {
              try {
                await deleteDoc(doc(db, "rooms", code, "participants", uid));
                toast.dismiss(t.id);
                toast.success(`👋 ${name} fue expulsado`);
              } catch (err) {
                console.error(err);
                toast.error("❌ Error al expulsar participante");
              }
            }}
            className="px-3 py-1 rounded bg-red-600 text-white text-xs"
          >
            Sí, expulsar
          </button>
          <button
            onClick={() => toast.dismiss(t.id)}
            className="px-3 py-1 rounded bg-gray-300 text-xs"
          >
            Cancelar
          </button>
        </div>
      </div>
    ));
  };

  /* ----------------------- lógica ----------------------- */
  const createRoom = async () => {
    if (!isNameSaved) return toast.error("💾 Guarda tu nombre primero");
    if (!question.trim()) return toast.error("❓ Escribe la primera pregunta");
    const maxC = Number(maxChoices) || 1; // por defecto 1 si está vacío
    if (maxC < 1) return toast.error("⚠️ Máx. opciones inválido");
    const max = Number(maxParticipants);
    const quo = Number(quorum);
    const choices = Number(maxChoices);

    if (!Number.isFinite(max) || max < 1) return toast.error("👥 Máximo de participantes inválido");
    if (!Number.isFinite(quo) || quo < 1) return toast.error("🧮 Quorum inválido");
    if (quo > max) return toast.error("⚠️ El quorum no puede ser mayor al máximo de participantes");
    if (!Number.isFinite(choices) || choices < 1) return toast.error("⚠️ Máx. opciones inválido");

    const newCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    const user = auth.currentUser;

    await setDoc(doc(db, "rooms", newCode), {
      createdAt: Date.now(),
      adminUid: user ? user.uid : null,
      adminName: userName,
      maxParticipants: max,
      quorum: quo,
    });

    const options = parseOptions(optionsInput);
    const votesObj = Object.fromEntries(options.map((o) => [o, 0]));

    await addDoc(collection(db, "rooms", newCode, "questions"), {
      question,
      options,
      votes: votesObj,
      closed: false,
      voters: [],
      maxChoices: maxC,
      isQuorumCheck: false,
    });

    if (user) {
      await setDoc(doc(db, "rooms", newCode, "participants", user.uid), {
        uid: user.uid,
        name: userName,
        joinedAt: Date.now(),
      });
    }

    setCode(newCode);
    setMode("room");
    setQuestion("");
    setOptionsInput("");
    setMaxParticipants("");
    setQuorum("");
    setMaxChoices("1");
    toast.success("🎉 Sala creada con éxito");
  };

  const joinRoom = async () => {
    if (!isNameSaved) return toast.error("💾 Guarda tu nombre primero");
    if (!joinCode.trim()) return toast.error("🔑 Escribe un código");

    const roomId = joinCode.toUpperCase();
    const ref = doc(db, "rooms", roomId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return toast.error("❌ Sala no encontrada");

    const data = snap.data();
    const participantsSnap = await getDocs(collection(db, "rooms", roomId, "participants"));

    if (participantsSnap.size >= (data.maxParticipants ?? Infinity)) {
      return toast.error("🚫 La sala alcanzó el máximo de participantes");
    }

    if (
      participantsSnap.docs.some(
        (d) => (d.data().name || "").toLowerCase() === userName.trim().toLowerCase()
      )
    ) {
      return toast.error("🚫 Ese nombre ya está en uso en la sala");
    }

    const user = auth.currentUser;
    if (user) {
      await setDoc(doc(db, "rooms", roomId, "participants", user.uid), {
        uid: user.uid,
        name: userName,
        joinedAt: Date.now(),
      });
    }

    setCode(roomId);
    setMode("room");
    toast.success("🙌 Te uniste a la sala");
  };

  useEffect(() => {
    if (!code) return;

    const unsubRoom = onSnapshot(doc(db, "rooms", code), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        setAdminUid(d.adminUid);
        setAdminName(d.adminName);
        setRoomData(d);
      }
    });

    const unsubQs = onSnapshot(collection(db, "rooms", code, "questions"), (snap) => {
      const qs = [];
      snap.forEach((d) => qs.push({ id: d.id, ...d.data() }));
      setQuestions(qs);
    });

    const unsubParticipants = onSnapshot(
      collection(db, "rooms", code, "participants"),
      (snap) => {
        const ps = [];
        snap.forEach((d) => ps.push(d.data()));
        setParticipants(ps);

        const user = auth.currentUser;
        if (user && !ps.some((p) => p.uid === user.uid)) {
          setMode("home");
          setCode(null);
          toast.error("❌ Has sido expulsado de la sala");
        }
      }
    );

    return () => {
      unsubRoom();
      unsubQs();
      unsubParticipants();
    };
  }, [code]);

  const addQuestion = async (isQuorumCheck = false) => {
    if (!isQuorumCheck && !question.trim()) return toast.error("❓ Escribe una pregunta");

    const options = isQuorumCheck ? ["Sí", "No"] : parseOptions(optionsInput);
    const votesObj = Object.fromEntries(options.map((o) => [o, 0]));

    await addDoc(collection(db, "rooms", code, "questions"), {
      question: isQuorumCheck ? "¿Confirmas tu presencia para el quorum?" : question,
      options,
      votes: votesObj,
      closed: false,
      voters: [],
      maxChoices: isQuorumCheck ? 1 : Number(maxChoices),
      isQuorumCheck,
    });

    setQuestion("");
    setOptionsInput("");
    setMaxChoices("1");
    toast.success(isQuorumCheck ? "🧮 Pregunta de quorum lanzada" : "➕ Pregunta agregada");
  };

  const votar = async (qId, opcionesSeleccionadas, qData) => {
    if (qData.closed) return toast.error("🔒 Pregunta cerrada");
    if (participants.length < (roomData?.quorum || 1)) {
      return toast.error("⚠️ Aún no se alcanza el quorum para votar");
    }

    const user = auth.currentUser;
    if (!user) return toast.error("🚫 No estás autenticado");

    const name = localStorage.getItem("userName") || "Anónimo";
    if (qData.voters.some((v) => v.uid === user.uid)) {
      return toast.error("🙅 Ya votaste en esta pregunta");
    }

    const newVotes = { ...qData.votes };
    opcionesSeleccionadas.forEach((op) => {
      newVotes[op] = (newVotes[op] || 0) + 1;
    });

    await updateDoc(doc(db, "rooms", code, "questions", qId), {
      votes: newVotes,
      voters: [...qData.voters, { uid: user.uid, name }],
    });

    toast.success("🗳️ Voto registrado");
  };

  const cerrarPregunta = async (qId) => {
    const q = questions.find((qq) => qq.id === qId);
    await updateDoc(doc(db, "rooms", code, "questions", qId), { closed: true });
    toast.success("🔒 Pregunta cerrada");
    if (q) generarPDF(q);
  };

  /* ----------------------- VISTAS ----------------------- */
  // ========= ROOM =========
  if (mode === "room") {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        {/* Header */}
        <header className="bg-primary text-white">
          <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between">
            <h1 className="text-lg sm:text-xl font-bold">
              🗳️ Sala #{code}
              {auth.currentUser?.uid === adminUid
                ? ` — Hola, ${userName} (Moderador)`
                : ` — Hola, ${userName}`}
            </h1>
            <button
              className="text-xs sm:text-sm underline decoration-white/60 hover:decoration-white"
              onClick={() => setMode("home")}
            >
              Salir
            </button>
          </div>
        </header>

        {/* Main */}
        <main className="flex-1 mx-auto max-w-5xl px-3 sm:px-4 py-6 sm:py-8 space-y-6">
          {/* Participantes */}
          <section className="rounded-2xl border border-black/5 bg-white p-4 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <h2 className="text-sm font-medium text-primary">
                Participantes ({participants.length}/{roomData?.maxParticipants ?? "∞"})
              </h2>
              <div className="text-xs sm:text-sm text-black/70">
                Quorum requerido: <b>{roomData?.quorum ?? "-"}</b> — Quorum actual:{" "}
                <b>{participants.length}</b>
              </div>
            </div>

            <ul className="mt-2 grid gap-1 sm:grid-cols-2 md:grid-cols-3">
              {participants.map((p) => (
                <li
                  key={p.uid}
                  className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm text-black/80"
                >
                  <span>
                    <span className="font-medium">{p.name}</span>
                    {p.uid === adminUid && (
                      <span className="ml-1 text-xs text-primary">(Moderador)</span>
                    )}
                  </span>
                  {auth.currentUser?.uid === adminUid && p.uid !== adminUid && (
                    <button
                      onClick={() => expulsarParticipante(p.uid, p.name)}
                      className="flex items-center gap-1 text-xs text-red-600 hover:underline"
                    >
                      🚫 Expulsar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* Crear pregunta (admin) */}
          {auth.currentUser?.uid === adminUid && (
            <section className="rounded-2xl border border-black/5 bg-white p-4 sm:p-6 shadow-sm">
              <h2 className="text-sm font-medium text-primary mb-2">Nueva pregunta</h2>
              <div className="flex flex-col gap-3 max-w-2xl">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Escribe la pregunta"
                  className="w-full rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
                <input
                  value={optionsInput}
                  onChange={(e) => setOptionsInput(e.target.value)}
                  placeholder="Opciones separadas por comas (ej: Sí,No,Abstención)"
                  className="w-full rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
                <input
                  type="number"
                  min={1}
                  value={maxChoices}
                  onChange={(e) => setMaxChoices(e.target.value)}
                  placeholder="Máximo de opciones que puede elegir cada votante"
                  className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    onClick={() => addQuestion(false)}
                    className="flex-1 rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light"
                  >
                    Agregar pregunta
                  </button>
                  <button
                    onClick={() => addQuestion(true)}
                    className="flex-1 rounded-lg bg-secondary px-4 py-2 text-white font-medium hover:opacity-90"
                  >
                    Lanzar confirmación de quorum
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Preguntas */}
          <section className="space-y-4">
            {questions.length === 0 && <p className="text-black/60">No hay preguntas aún.</p>}

            {questions.map((q) => {
              const total = Object.values(q.votes).reduce((a, b) => a + b, 0);
              const esMultiple = q.maxChoices > 1;

              return (
                <div
                  key={q.id}
                  className="rounded-2xl border border-black/5 bg-white p-4 sm:p-5 shadow-sm"
                >
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                    <h3 className="text-base sm:text-lg font-semibold">
                      {q.question}{" "}
                      {q.closed && (
                        <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                          Cerrada
                        </span>
                      )}
                      {q.isQuorumCheck && (
                        <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                          Quorum
                        </span>
                      )}
                    </h3>
                    {auth.currentUser?.uid === adminUid && !q.closed && (
                      <button
                        onClick={() => cerrarPregunta(q.id)}
                        className="text-xs sm:text-sm text-secondary hover:underline"
                      >
                        🔒 Cerrar
                      </button>
                    )}
                  </div>

                  <p className="mt-1 text-xs text-black/70">
                    Total votos: <b>{total}</b> — Quorum actual:{" "}
                    <b>{participants.length}</b>/<b>{roomData?.quorum}</b>
                  </p>

                  {/* Votación */}
                  {!q.closed && (
                    <div className="mt-3 space-y-2">
                      {esMultiple ? (
                        <div>
                          {q.options.map((op) => (
                            <label
                              key={op}
                              className="flex items-center gap-2 text-sm text-black/80"
                            >
                              <input
                                type="checkbox"
                                checked={selectedOptions[q.id]?.includes(op) || false}
                                onChange={(e) => {
                                  const prev = selectedOptions[q.id] || [];
                                  if (e.target.checked) {
                                    if (prev.length < q.maxChoices) {
                                      setSelectedOptions({
                                        ...selectedOptions,
                                        [q.id]: [...prev, op],
                                      });
                                    } else {
                                      toast.error(
                                        `⚠️ Solo puedes elegir hasta ${q.maxChoices} opciones`
                                      );
                                    }
                                  } else {
                                    setSelectedOptions({
                                      ...selectedOptions,
                                      [q.id]: prev.filter((x) => x !== op),
                                    });
                                  }
                                }}
                              />
                              {op} ({q.votes[op]})
                            </label>
                          ))}
                          <button
                            onClick={() =>
                              votar(q.id, selectedOptions[q.id] || [], q)
                            }
                            className="mt-2 w-full sm:w-auto rounded-lg bg-primary px-3 py-2 text-white text-sm hover:bg-primary-light"
                          >
                            Enviar voto
                          </button>
                        </div>
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                          {q.options.map((op) => (
                            <button
                              key={op}
                              onClick={() => votar(q.id, [op], q)}
                              disabled={q.closed}
                              className="w-full rounded-lg bg-primary px-3 py-2 text-white text-sm sm:text-base font-medium hover:bg-primary-light disabled:opacity-50"
                            >
                              {op} ({q.votes[op]})
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </main>

        {/* Footer */}
        <footer className="bg-primary-dark text-white mt-auto">
          <div className="mx-auto max-w-5xl px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm opacity-90">
            © {new Date().getFullYear()} Mesas de Votación — Votaciones en tiempo real.
          </div>
        </footer>

        <Toaster position="top-center" toastOptions={{ duration: 3000 }} />
      </div>
    );
  }

  // ========= HOME =========
  if (mode === "home") {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        {/* Header */}
        <header className="bg-primary text-white">
          <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 sm:py-4">
            <h1 className="text-lg sm:text-xl font-bold">🗳️ Mesas de Votación</h1>
          </div>
        </header>

        {/* Main */}
        <main className="flex-1 mx-auto max-w-5xl px-3 sm:px-4 py-6 sm:py-10 space-y-8">
          {/* Tu nombre */}
          <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm max-w-lg mx-auto">
            <h3 className="text-base sm:text-lg font-semibold text-primary mb-4">Tu nombre</h3>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Ingresa tu nombre"
                className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                onClick={handleSetName}
                className="w-full sm:w-auto rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light"
              >
                Guardar
              </button>
            </div>
          </section>

          {/* Menú de rol */}
          <div className="grid gap-6 sm:grid-cols-1 md:grid-cols-2">
            <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
              <h3 className="text-base sm:text-lg font-semibold text-primary mb-3">Moderador</h3>
              <p className="text-sm text-black/70 mb-4">
                Crea una sala, define máximo de participantes y quorum.
              </p>
              <button
                onClick={() => setMode("moderator")}
                disabled={!isNameSaved}
                className={`w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white ${isNameSaved ? "bg-primary hover:bg-primary-light" : "bg-gray-400 cursor-not-allowed"
                  }`}
              >
                Continuar como moderador
              </button>
            </section>

            <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
              <h3 className="text-base sm:text-lg font-semibold text-primary mb-3">Votante</h3>
              <p className="text-sm text-black/70 mb-4">
                Únete a una sala con su código y participa en las votaciones.
              </p>
              <button
                onClick={() => setMode("voter")}
                disabled={!isNameSaved}
                className={`w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white ${isNameSaved ? "bg-secondary hover:opacity-90" : "bg-gray-400 cursor-not-allowed"
                  }`}
              >
                Continuar como votante
              </button>
            </section>
          </div>
        </main>

        {/* Footer */}
        <footer className="bg-primary-dark text-white mt-auto">
          <div className="mx-auto max-w-5xl px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm opacity-90">
            © {new Date().getFullYear()} Mesas de Votación — Votaciones en tiempo real - GRZN 2025.
          </div>
        </footer>

        <Toaster position="top-center" toastOptions={{ duration: 3000 }} />
      </div>
    );
  }

  // ========= MODERATOR =========
  if (mode === "moderator") {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        {/* Header */}
        <header className="bg-primary text-white">
          <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 sm:py-4 flex items-center justify-between">
            <h1 className="text-lg sm:text-xl font-bold">Crear sala (Moderador)</h1>
            <button
              onClick={() => setMode("home")}
              className="text-xs sm:text-sm underline decoration-white/60 hover:decoration-white"
            >
              ← Volver
            </button>
          </div>
        </header>

        {/* Main */}
        <main className="flex-1 mx-auto max-w-5xl px-3 sm:px-4 py-6 sm:py-10">
          <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm max-w-xl mx-auto">
            <h3 className="text-base sm:text-lg font-semibold text-primary mb-4">Configurar sala</h3>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Ingresa tu nombre"
                  className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  onClick={handleSetName}
                  className="w-full sm:w-auto rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light"
                >
                  Guardar nombre
                </button>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <input
                  type="number"
                  min={1}
                  value={maxParticipants}
                  onChange={(e) => setMaxParticipants(e.target.value)}
                  placeholder="Número máximo de participantes"
                  className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
                <input
                  type="number"
                  min={1}
                  value={quorum}
                  onChange={(e) => setQuorum(e.target.value)}
                  placeholder="Quorum mínimo requerido"
                  className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Escribe la primera pregunta de la sala"
                className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
              />
              <input
                value={optionsInput}
                onChange={(e) => setOptionsInput(e.target.value)}
                placeholder="Opciones separadas por comas (ej: Sí,No,Abstención)"
                className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
              />
              <input
                type="number"
                min={1}
                value={maxChoices}
                onChange={(e) => setMaxChoices(e.target.value)}
                placeholder="Máximo de opciones seleccionables"
                className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
              />

              <button
                onClick={createRoom}
                disabled={!isNameSaved}
                className={`w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white ${isNameSaved ? "bg-primary hover:bg-primary-light" : "bg-gray-400 cursor-not-allowed"
                  }`}
              >
                Crear sala
              </button>
            </div>
          </section>
        </main>

        {/* Footer */}
        <footer className="bg-primary-dark text-white mt-auto">
          <div className="mx-auto max-w-5xl px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm opacity-90">
            © {new Date().getFullYear()} Mesas de Votación — Votaciones en tiempo real.
          </div>
        </footer>

        <Toaster position="top-center" toastOptions={{ duration: 3000 }} />
      </div>
    );
  }

  // ========= VOTER =========
  if (mode === "voter") {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        {/* Header */}
        <header className="bg-primary text-white">
          <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 sm:py-4 flex items-center justify-between">
            <h1 className="text-lg sm:text-xl font-bold">Unirse a sala (Votante)</h1>
            <button
              onClick={() => setMode("home")}
              className="text-xs sm:text-sm underline decoration-white/60 hover:decoration-white"
            >
              ← Volver
            </button>
          </div>
        </header>

        {/* Main */}
        <main className="flex-1 mx-auto max-w-5xl px-3 sm:px-4 py-6 sm:py-10">
          <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm max-w-xl mx-auto">
            <h3 className="text-base sm:text-lg font-semibold text-primary mb-4">Ingresar a una sala</h3>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Ingresa tu nombre"
                  className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  onClick={handleSetName}
                  className="w-full sm:w-auto rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light"
                >
                  Guardar nombre
                </button>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="Código de la sala (ej: ABC12)"
                  className="flex-1 rounded-lg border border-black/10 px-3 py-2 uppercase tracking-wider outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  onClick={joinRoom}
                  disabled={!isNameSaved}
                  className={`w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white ${isNameSaved ? "bg-secondary hover:opacity-90" : "bg-gray-400 cursor-not-allowed"
                    }`}
                >
                  Entrar
                </button>
              </div>
            </div>
          </section>
        </main>

        {/* Footer */}
        <footer className="bg-primary-dark text-white mt-auto">
          <div className="mx-auto max-w-5xl px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm opacity-90">
            © {new Date().getFullYear()} Mesas de Votación — Votaciones en tiempo real - GRZN 2025.
          </div>
        </footer>

        <Toaster position="top-center" toastOptions={{ duration: 3000 }} />
      </div>
    );
  }

  return null;
}
