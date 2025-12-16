import { useState, useEffect, useMemo, useRef } from "react";
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
  serverTimestamp,
  query,
  orderBy,
  runTransaction,
} from "firebase/firestore";
import { Toaster, toast } from "react-hot-toast";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export default function App() {
  // modes: "home" | "moderator" | "voter" | "presenter" | "room" | "presenter_room"
  const [mode, setMode] = useState("home");

  // rol dentro de la sala
  const [isPresenter, setIsPresenter] = useState(false);

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
  const [joinCode, setJoinCode] = useState("");

  // moderador: parámetros de preguntas
  const [question, setQuestion] = useState("");
  const [optionsInput, setOptionsInput] = useState("");
  const [maxChoices, setMaxChoices] = useState(""); // vacío por defecto

  // moderador: configurar sala
  const [maxParticipants, setMaxParticipants] = useState("");

  // respuesta múltiple (cliente)
  const [selectedOptions, setSelectedOptions] = useState({});

  // Delegación (UI al unirse como votante)
  const [hasDelegation, setHasDelegation] = useState(false);
  const [delegateName, setDelegateName] = useState("");

  // Evitar doble envío por latencia
  const sendingVoteForQ = useRef({}); // { [qId]: boolean }

  /* ----------------------- helpers ----------------------- */
  const handleSetName = () => {
    if (!userName.trim()) return toast.error("⚠️ Escribe tu nombre");
    localStorage.setItem("userName", userName.trim());
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

  const sortOptions = (opts, votesObj) =>
    [...opts].sort((a, b) => (votesObj?.[b] || 0) - (votesObj?.[a] || 0));

  const randomCode = (n = 5) => {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: n }, () => A[Math.floor(Math.random() * A.length)]).join("");
  };

  /* ----------------------- PDF (global) ----------------------- */
  const generarPDFSala = () => {
    const pdf = new jsPDF();
    const fecha = new Date().toLocaleString();

    pdf.text("Resultados de votación", 14, 14);
    pdf.text(`Sala: ${code}`, 14, 22);
    pdf.text(`Fecha: ${fecha}`, 14, 30);

    let startY = 38;

    questions
      .filter((q) => !q.isPresenceSurvey) // excluir encuesta de votantes activos
      .forEach((pregunta, idx) => {
        const qd = pregunta;
        const quorumDecisorio = Math.floor((qd.npvp || 0) / 2) + 1;

        pdf.setFontSize(12);
        pdf.text(`${idx + 1}. ${qd.question}`, 14, startY);
        pdf.setFontSize(10);
        pdf.text(
          `NPVP: ${qd.npvp || 0} · Quorum decisorio: ${quorumDecisorio}`,
          14,
          startY + 6
        );

        // Tabla de resultados (ordenada por más votadas SOLO en el PDF)
        autoTable(pdf, {
          startY: startY + 10,
          head: [["Opción", "Votos"]],
          body: sortOptions(qd.options, qd.votes).map((o) => [o, String(qd.votes[o] || 0)]),
          styles: { fontSize: 10 },
        });

        // Listado de votantes también en el reporte final
        const nextY = pdf.lastAutoTable.finalY + 6;
        pdf.text("Votantes:", 14, nextY);
        const votersRows = (qd.voters || []).map((v) => [
          v.name || v.uid,
          String((v.choices || []).length),
        ]);
        autoTable(pdf, {
          startY: nextY + 2,
          head: [["Nombre", "Votos en el envío"]],
          body: votersRows.length ? votersRows : [["—", "—"]],
          styles: { fontSize: 9 },
        });

        startY = pdf.lastAutoTable.finalY + 10;
      });

    pdf.save(`informe_sala_${code}.pdf`);
  };

  // PDF individual por pregunta (se llama al cerrar)
  const generarPDFPregunta = async (qId) => {
    const qRef = doc(db, "rooms", code, "questions", qId);
    const qSnap = await getDoc(qRef);
    if (!qSnap.exists()) return;
    const q = { id: qSnap.id, ...qSnap.data() };

    const pdf = new jsPDF();
    pdf.setFontSize(14);
    pdf.text("Resultados de la pregunta", 14, 14);
    pdf.setFontSize(12);
    pdf.text(String(q.question || ""), 14, 22);

    if (q.isPresenceSurvey) {
      pdf.text("Encuesta de votantes activos (NPVP)", 14, 30);
    } else {
      const quorumDecisorio = Math.floor((q.npvp || 0) / 2) + 1;
      pdf.text(`NPVP: ${q.npvp || 0} · Quorum decisorio: ${quorumDecisorio}`, 14, 30);
    }

    const opcionesOrden = sortOptions(q.options || [], q.votes || {});
    autoTable(pdf, {
      startY: 36,
      head: [["Opción", "Votos"]],
      body: opcionesOrden.map((o) => [o, String(q.votes?.[o] || 0)]),
      styles: { fontSize: 11 },
    });

    // listado privado (usa los nombres guardados en voters)
    const bodyY = pdf.lastAutoTable ? pdf.lastAutoTable.finalY + 8 : 36;
    pdf.setFontSize(11);
    pdf.text("Votantes (privado - sólo moderador)", 14, bodyY);
    let y = bodyY + 6;
    (q.voters || []).forEach((v) => {
      const label = `${v.name || v.uid} — votos en este envío: ${(v.choices || []).length}`;
      pdf.text(label, 14, y);
      y += 6;
    });

    const safe = (q.question || `pregunta_${qId}`).slice(0, 60);
    pdf.save(`resultado_${safe}.pdf`);
  };

  /* ----------------------- lógica ----------------------- */
  // Crear sala (sin pregunta inicial, sin “quorum requerido”)
  const createRoom = async () => {
    if (!isNameSaved) return toast.error("💾 Guarda tu nombre primero");
    if (!auth.currentUser) return toast.error("🔐 Debes estar autenticado");

    const max = Number(maxParticipants);
    if (!Number.isFinite(max) || max < 1) return toast.error("👥 Máximo de participantes inválido");

    const newCode = randomCode(5);

    await setDoc(doc(db, "rooms", newCode), {
      createdAt: serverTimestamp(),
      adminUid: auth.currentUser.uid,
      adminName: userName.trim(),
      maxParticipants: max,
      npvp: 0,
      npvpUpdatedAt: null,
      npvpInitialized: false,
    });

    // Registrar moderador como participante (sin delegación)
    await setDoc(doc(db, "rooms", newCode, "participants", auth.currentUser.uid), {
      uid: auth.currentUser.uid,
      name: userName.trim(),
      joinedAt: Date.now(),
      hasDelegation: false,
      delegateName: null,
    });

    setCode(newCode);
    setMode("room");
    setMaxParticipants("");
    toast.success("🎉 Sala creada. Lanza la encuesta de votantes activos.");
  };

  const joinRoom = async () => {
    if (!isNameSaved) return toast.error("💾 Guarda tu nombre primero");
    if (!joinCode.trim()) return toast.error("🔑 Escribe un código");
    if (!auth.currentUser) return toast.error("🔐 Debes estar autenticado");

    const roomId = joinCode.toUpperCase();
    const ref = doc(db, "rooms", roomId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return toast.error("❌ Sala no encontrada");
    const data = snap.data();

    const participantsSnap = await getDocs(collection(db, "rooms", roomId, "participants"));
    if (participantsSnap.size >= (data.maxParticipants ?? Infinity)) {
      return toast.error("🚫 La sala alcanzó el máximo de participantes");
    }

    // Permitir reingreso desde el mismo usuario aunque el nombre exista
    const nameAlreadyTakenByAnother =
      participantsSnap.docs.some(
        (d) =>
          d.id !== auth.currentUser.uid &&
          (d.data().name || "").toLowerCase() === userName.trim().toLowerCase()
      );

    if (nameAlreadyTakenByAnother) {
      return toast.error("🚫 Ese nombre ya está en uso en la sala");
    }

    await setDoc(doc(db, "rooms", roomId, "participants", auth.currentUser.uid), {
      uid: auth.currentUser.uid,
      name: userName.trim(),
      joinedAt: Date.now(),
      hasDelegation: !!hasDelegation,
      delegateName: hasDelegation && delegateName.trim() ? delegateName.trim() : null,
    });

    setCode(roomId);
    setMode("room");
    toast.success("🙌 Te uniste a la sala");
  };

// Unirse como PRESENTADOR (no participa, no se registra en participants)
const joinPresenter = async () => {
  if (!joinCode.trim()) return toast.error("🔑 Escribe un código");

  const roomId = joinCode.toUpperCase();
  const ref = doc(db, "rooms", roomId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return toast.error("❌ Sala no encontrada");

  setIsPresenter(true);
  setCode(roomId);
  setMode("presenter_room");
  toast.success("🖥️ Vista de presentador activada");
};

  useEffect(() => {
    if (!code) return;
    const unsubRoom = onSnapshot(doc(db, "rooms", code), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        setAdminUid(d.adminUid);
        setAdminName(d.adminName);
        setRoomData({ id: snap.id, ...d });
      }
    });

    const unsubQs = onSnapshot(
      query(collection(db, "rooms", code, "questions"), orderBy("createdAt", "asc")),
      (snap) => {
        const qs = [];
        snap.forEach((d) => qs.push({ id: d.id, ...d.data() }));
        setQuestions(qs);
      }
    );

    const unsubParticipants = onSnapshot(
      collection(db, "rooms", code, "participants"),
      (snap) => {
        const ps = [];
        snap.forEach((d) => ps.push(d.data()));
        setParticipants(ps);

        // auto-salida si te expulsan
        const user = auth.currentUser;
        if (user && !isPresenter && !ps.some((p) => p.uid === user.uid)) {
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

  // Lanza ENCUESTA DE VOTANTES ACTIVOS (solo opción "Sí")
  const launchPresenceSurvey = async () => {
    if (!auth.currentUser || auth.currentUser.uid !== adminUid)
      return toast.error("🚫 Solo el moderador puede lanzar la encuesta");

    await addDoc(collection(db, "rooms", code, "questions"), {
      question: "¿Confirmas que estás presente y activo/a para votar?",
      options: ["Sí"], // solo 'Sí' como se solicitó
      votes: { "Sí": 0 },
      voters: [], // [{ uid, name, choices: ['Sí'] }]
      maxChoices: 1,
      isPresenceSurvey: true,
      closed: false,
      createdAt: Date.now(),
      npvp: roomData?.npvp || 0, // snapshot previo
    });

    toast.success("🧮 Encuesta de votantes activos lanzada");
  };

  // Cerrar pregunta (si es de presencia => calcula NPVP y habilita crear preguntas)
  const cerrarPregunta = async (qId, qData) => {
    if (!auth.currentUser || auth.currentUser.uid !== adminUid)
      return toast.error("🚫 Solo el moderador puede cerrar");

    await updateDoc(doc(db, "rooms", code, "questions", qId), { closed: true });

    if (qData.isPresenceSurvey) {
      const fresh = await getDoc(doc(db, "rooms", code, "questions", qId));
      const pq = fresh.data();

      // NPVP = # de votantes que marcaron "Sí"
      const npvp = (pq.voters || []).filter((v) => (v.choices || []).includes("Sí")).length;

      await updateDoc(doc(db, "rooms", code), {
        npvp,
        npvpUpdatedAt: Date.now(),
        npvpInitialized: true,
      });

      toast.success(`✅ NPVP actualizado: ${npvp}. Ya puedes crear preguntas.`);
    } else {
      toast.success("🔒 Pregunta cerrada");
    }

    // PDF individual de esta pregunta
    await generarPDFPregunta(qId);
  };

  // Crear PREGUNTA NORMAL (bloqueada hasta npvpInitialized)
  const addQuestion = async () => {
    if (!auth.currentUser || auth.currentUser.uid !== adminUid)
      return toast.error("🚫 Solo el moderador puede crear preguntas");
    if (!roomData?.npvpInitialized)
      return toast.error("⚠️ Primero debes confirmar votantes activos (NPVP).");
    if (!question.trim()) return toast.error("❓ Escribe una pregunta");

    const options = parseOptions(optionsInput);
    const votesObj = Object.fromEntries(options.map((o) => [o, 0]));

    // por defecto 1 (se reportó que quedaba "ilimitado")
    const choices = Number(maxChoices);
    const normalizedChoices = Number.isFinite(choices) && choices > 0 ? choices : 1;

    await addDoc(collection(db, "rooms", code, "questions"), {
      question: question.trim(),
      options,
      votes: votesObj,
      voters: [], // guardaremos una entrada por envío (si hay delegación, podrá haber 2)
      maxChoices: normalizedChoices,
      isPresenceSurvey: false,
      closed: false,
      createdAt: Date.now(),
      npvp: roomData?.npvp || 0, // snapshot NPVP
    });

    setQuestion("");
    setOptionsInput("");
    setMaxChoices("");
    toast.success("➕ Pregunta agregada");
  };

  // Votar
  // - Moderador NO puede votar.
  // - Presencia: límite 1 para todos.
  // - Normal: límite 2 si hasDelegation, si no 1; puede enviar en dos tandas.
  // - Etiquetado si hay delegación: primer voto con su nombre, segundo "en representación de X".
  // ---------------------------
// VOTAR (con transacción - evita pisado por concurrencia)
// ---------------------------
const votar = async (qId, opcionesSeleccionadas, qData) => {
  const user = auth.currentUser;
  if (!user) return toast.error("🚫 No estás autenticado");

  if (sendingVoteForQ.current[qId]) return; // evitar dobles clics por latencia
  sendingVoteForQ.current[qId] = true;

  try {
    // Moderador no vota
    if (user.uid === adminUid) {
      toast.error("👀 El moderador no vota, solo modera.");
      return;
    }

    // Info del participante (delegación)
    const myPartSnap = await getDoc(doc(db, "rooms", code, "participants", user.uid));
    const me = myPartSnap.data() || {};
    const limit = qData.isPresenceSurvey ? 1 : me.hasDelegation ? 2 : 1;

    const qRef = doc(db, "rooms", code, "questions", qId);

    // Para el toast (voto 1/2 o 2/2) calculado con data fresca
    let voteIdx = 1;

    await runTransaction(db, async (tx) => {
      const freshSnap = await tx.get(qRef);
      if (!freshSnap.exists()) throw new Error("Pregunta no encontrada");

      const fresh = freshSnap.data() || {};

      if (fresh.closed) throw new Error("🔒 Pregunta cerrada");

      // Veces que ya votó este usuario (con data fresca)
      const yaVeces = (fresh.voters || []).filter((v) => v.uid === user.uid).length;
      voteIdx = yaVeces + 1;

      if (yaVeces >= limit) {
        throw new Error(
          fresh.isPresenceSurvey
            ? "Solo puedes responder una vez la encuesta de votantes activos."
            : "Ya alcanzaste tu límite de votos para esta pregunta."
        );
      }

      // maxChoices por envío (solo preguntas normales)
      if (
        !fresh.isPresenceSurvey &&
        fresh.maxChoices > 0 &&
        (opcionesSeleccionadas || []).length > fresh.maxChoices
      ) {
        throw new Error(`⚠️ Máximo ${fresh.maxChoices} opciones por envío`);
      }

      // Incremento de votos (con data fresca)
      const newVotes = { ...(fresh.votes || {}) };
      (opcionesSeleccionadas || []).forEach((op) => {
        newVotes[op] = (newVotes[op] || 0) + 1;
      });

      // Nombre mostrado (delegación)
      let displayName = localStorage.getItem("userName") || "Anónimo";
      if (!fresh.isPresenceSurvey && me.hasDelegation) {
        // Si es el 2do voto, se marca "en representación..."
        if (yaVeces === 1) {
          const rep = me.delegateName?.trim() || "su delegado";
          displayName = `${displayName} en representación de ${rep}`;
        }
      }

      tx.update(qRef, {
        votes: newVotes,
        voters: [
          ...(fresh.voters || []),
          { uid: user.uid, name: displayName, choices: opcionesSeleccionadas },
        ],
      });
    });

    const tail =
      !qData.isPresenceSurvey && me.hasDelegation && limit === 2 ? ` (voto ${voteIdx}/2)` : "";
    toast.success("🗳️ Voto registrado" + tail);
  } catch (err) {
    toast.error(err?.message || "❌ Error registrando el voto");
  } finally {
    sendingVoteForQ.current[qId] = false;
  }
};

  // Cancelar un voto de un participante (moderador)
  const cancelarVoto = async (qId, voterIndex) => {
    if (!auth.currentUser || auth.currentUser.uid !== adminUid)
      return toast.error("🚫 Solo el moderador puede cancelar votos");

    const qRef = doc(db, "rooms", code, "questions", qId);
    const snap = await getDoc(qRef);
    if (!snap.exists()) return;

    const q = snap.data();
    const voters = [...(q.voters || [])];
    if (voterIndex < 0 || voterIndex >= voters.length) return;

    const toRemove = voters[voterIndex];
    const newVotes = { ...(q.votes || {}) };
    (toRemove.choices || []).forEach((op) => {
      newVotes[op] = Math.max(0, (newVotes[op] || 0) - 1);
    });

    voters.splice(voterIndex, 1);

    await updateDoc(qRef, { votes: newVotes, voters });
    toast.success("🧹 Voto cancelado");
  };

  const expulsarParticipante = (uid, name) => {
    if (!auth.currentUser || auth.currentUser.uid !== adminUid) {
      return toast.error("🚫 Solo el moderador puede expulsar");
    }
    deleteDoc(doc(db, "rooms", code, "participants", uid))
      .then(() => toast.success(`👋 ${name} fue expulsado`))
      .catch(() => toast.error("❌ Error al expulsar participante"));
  };

  /* ----------------------- Vistas ----------------------- */
  const isAdmin = useMemo(() => auth.currentUser?.uid === adminUid, [adminUid]);

  // ========= ROOM =========
  
// ========= PRESENTER ROOM =========
if (mode === "presenter_room") {
  const current = questions.find((q) => !q.isPresenceSurvey && !q.closed) || null;
  const totalVotes = current ? Object.values(current.votes || {}).reduce((a, b) => a + b, 0) : 0;
  const quorumDecisorio = current ? Math.floor((current.npvp || 0) / 2) + 1 : 0;

  return (
    <div className="min-h-screen w-full bg-purple-900 text-white flex flex-col">
      <div className="px-6 py-4 flex items-center justify-between border-b border-white/15">
        <div className="text-2xl font-bold tracking-wide">Mesa de votación</div>
        <div className="text-right">
          <div className="text-sm opacity-80">Código de sala</div>
          <div className="text-3xl font-extrabold tracking-widest">{code}</div>
        </div>
      </div>

      <main className="flex-1 px-6 py-8 flex flex-col justify-center">
        <div className="max-w-5xl mx-auto w-full space-y-8">
          <div className="rounded-2xl bg-white/10 border border-white/15 p-8">
            <div className="flex flex-col gap-3">
              <div className="text-sm uppercase tracking-widest opacity-80">Pregunta actual</div>

              {current ? (
                <>
                  <div className="text-4xl font-extrabold leading-tight">{current.question}</div>

                  <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs uppercase tracking-widest opacity-80">Estado</div>
                      <div className="text-2xl font-bold">{current.closed ? "Cerrada" : "Abierta"}</div>
                    </div>

                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs uppercase tracking-widest opacity-80">NPVP</div>
                      <div className="text-2xl font-bold">{current.npvp || 0}</div>
                    </div>

                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs uppercase tracking-widest opacity-80">Quórum decisorio</div>
                      <div className="text-2xl font-bold">{quorumDecisorio}</div>
                    </div>
                  </div>

                  <div className="mt-4 text-lg opacity-90">
                    Total de votos registrados: <b>{totalVotes}</b>
                  </div>

                  <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                    {(current.options || []).map((op) => (
                      <div
                        key={op}
                        className="rounded-xl bg-white/10 border border-white/15 px-5 py-4 text-2xl font-semibold"
                      >
                        {op}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-3xl font-bold opacity-90">
                  No hay una pregunta abierta en este momento.
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between text-sm opacity-90">
            <div>
              Participantes conectados: <b>{participants.length}</b>
            </div>
            <button
              onClick={() => {
                setMode("home");
                setCode(null);
                setIsPresenter(false);
              }}
              className="rounded-lg bg-white/15 hover:bg-white/20 px-4 py-2 font-medium"
            >
              Salir
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

if (mode === "room") {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        {/* Header */}
        <header className="bg-primary text-white">
          <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between">
            <h1 className="text-lg sm:text-xl font-bold">
              🗳️ Sala #{code} {isAdmin ? `— Hola, ${userName} (Moderador)` : `— Hola, ${userName}`}
            </h1>
            <div className="flex items-center gap-3">
              {isAdmin && (
                <button
                  onClick={generarPDFSala}
                  className="text-xs sm:text-sm underline decoration-white/60 hover:decoration-white"
                >
                  📄 Descargar informe
                </button>
              )}
              <button
                className="text-xs sm:text-sm underline decoration-white/60 hover:decoration-white"
                onClick={() => {
                  setMode("home");
                  setCode(null);
                }}
              >
                Salir
              </button>
            </div>
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
                NPVP actual: <b>{roomData?.npvp ?? 0}</b>{" "}
                {roomData?.npvpInitialized ? "(habilitado)" : "(pendiente inicializar)"}
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
                    {p.hasDelegation && (
                      <span className="ml-1 text-xs text-secondary">(delegación)</span>
                    )}
                  </span>

                  {isAdmin && p.uid !== adminUid && (
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

          {/* Controles moderador */}
          {isAdmin && (
            <section className="rounded-2xl border border-black/5 bg-white p-4 sm:p-6 shadow-sm">
              <h2 className="text-sm font-medium text-primary mb-2">Moderación</h2>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={launchPresenceSurvey}
                  className="flex-1 rounded-lg bg-secondary px-4 py-2 text-white font-medium hover:opacity-90"
                >
                  Encuesta de votantes activos
                </button>
              </div>
            </section>
          )}

          {/* Crear pregunta (admin) */}
          {isAdmin && (
            <section className="rounded-2xl border border-black/5 bg-white p-4 sm:p-6 shadow-sm">
              <h2 className="text-sm font-medium text-primary mb-2">Nueva pregunta</h2>
              {roomData?.npvpInitialized ? (
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
                    placeholder="Máximo de opciones seleccionables"
                    className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    onClick={addQuestion}
                    className="w-full sm:w-auto rounded-lg bg-primary px-4 py-2 text-white font-medium hover:bg-primary-light"
                  >
                    Agregar pregunta
                  </button>
                </div>
              ) : (
                <p className="text-sm text-black/70">
                  Debes cerrar la <b>Encuesta de votantes activos</b> para habilitar la creación de
                  preguntas.
                </p>
              )}
            </section>
          )}

          {/* Encuesta de votantes activos (abierta) */}
          {questions
            .filter((q) => q.isPresenceSurvey && !q.closed)
            .map((q) => (
              <div
                key={q.id}
                className="rounded-2xl border border-blue-200 bg-blue-50 p-4 sm:p-5 shadow-sm"
              >
                <h3 className="text-base sm:text-lg font-semibold text-blue-700">
                  {q.question}
                  <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                    Encuesta de votantes activos
                  </span>
                </h3>

                {/* Solo opción 'Sí' en pantalla */}
                <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                  {q.options.map((op) => (
                    <button
                      key={op}
                      onClick={() => votar(q.id, [op], q)}
                      disabled={q.closed || isAdmin} // moderador no puede votar
                      className="w-full rounded-lg bg-blue-600 px-3 py-2 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                    >
                      {q.closed ? `${op} (${q.votes[op] || 0})` : op}
                    </button>
                  ))}
                </div>

                {isAdmin && (
                  <div className="mt-3">
                    <button
                      onClick={() => cerrarPregunta(q.id, q)}
                      className="text-sm text-secondary hover:underline"
                    >
                      🔒 Cerrar encuesta y fijar NPVP
                    </button>
                  </div>
                )}
              </div>
            ))}

          {/* Preguntas normales */}
          <section className="space-y-4">
            {questions.filter((q) => !q.isPresenceSurvey).length === 0 && (
              <p className="text-black/60">No hay preguntas aún.</p>
            )}

            {questions
              .filter((q) => !q.isPresenceSurvey)
              .map((q) => {
                const total = Object.values(q.votes || {}).reduce((a, b) => a + b, 0);
                // En pantalla NO reordenamos para que no "salten" los botones
                const opcionesOrden = q.options || [];
                const quorumDecisorio = Math.floor((q.npvp || 0) / 2) + 1;

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
                      </h3>

                      {isAdmin && !q.closed && (
                        <button
                          onClick={() => cerrarPregunta(q.id, q)}
                          className="text-xs sm:text-sm text-secondary hover:underline"
                        >
                          🔒 Cerrar
                        </button>
                      )}
                    </div>

                    <p className="mt-1 text-xs text-black/70">
                      Total votos: <b>{total}</b> — NPVP (pregunta): <b>{q.npvp || 0}</b> — Quorum
                      decisorio: <b>{quorumDecisorio}</b>
                    </p>


{/* Resultados visibles al cerrar (publicación) */}
{q.closed && (
  <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
    {(q.options || []).map((op) => (
      <div
        key={op}
        className="w-full rounded-lg bg-gray-100 px-3 py-2 text-sm sm:text-base font-medium text-black/80 border border-black/5"
      >
        {op} ({q.votes?.[op] || 0})
      </div>
    ))}
  </div>
)}

                    {!q.closed && (
                      <div className="mt-3">
                        {q.maxChoices > 1 ? (
                          <div className="space-y-2">
                            {q.options.map((op) => (
                              <label key={op} className="flex items-center gap-2 text-sm text-black/80">
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
                                {q.closed ? `${op} (${q.votes[op] || 0})` : op}
                              </label>
                            ))}
                            <button
                              onClick={() => votar(q.id, selectedOptions[q.id] || [], q)}
                              disabled={isAdmin} // moderador no puede enviar
                              className="mt-2 w-full sm:w-auto rounded-lg bg-primary px-3 py-2 text-white text-sm hover:bg-primary-light disabled:opacity-50"
                            >
                              Enviar voto
                            </button>
                          </div>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                            {opcionesOrden.map((op) => (
                              <button
                                key={op}
                                onClick={() => votar(q.id, [op], q)}
                                disabled={q.closed || isAdmin}
                                className="w-full rounded-lg bg-primary px-3 py-2 text-white text-sm sm:text-base font-medium hover:bg-primary-light disabled:opacity-50"
                              >
                                {q.closed ? `${op} (${q.votes[op] || 0})` : op}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Votantes (privado para moderador) + Cancelar voto */}
                    {isAdmin && (
                      <div className="mt-3">
                        <div className="text-xs font-semibold text-primary">Votantes (privado)</div>
                        {(q.voters || []).length === 0 ? (
                          <div className="text-xs text-black/60">Sin votos registrados aún.</div>
                        ) : (
                          <ul className="text-xs space-y-1 mt-1">
                            {(q.voters || []).map((v, idx) => (
                              <li key={`${v.uid}-${idx}`} className="text-black/80">
                                {v.name || v.uid} — votos en este envío:{" "}
                                {(v.choices || []).length}
                                {!q.closed && (
                                  <button
                                    className="ml-2 text-red-600 hover:underline"
                                    onClick={() => cancelarVoto(q.id, idx)}
                                  >
                                    Cancelar voto
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
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
        <header className="bg-primary text-white">
          <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 sm:py-4">
            <h1 className="text-lg sm:text-xl font-bold">🗳️ Mesas de Votación</h1>
          </div>
        </header>

        <main className="flex-1 mx-auto max-w-5xl px-3 sm:px-4 py-6 sm:py-10 space-y-8">
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

          <div className="grid gap-6 sm:grid-cols-1 md:grid-cols-2">
            <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
              <h3 className="text-base sm:text-lg font-semibold text-primary mb-3">Moderador</h3>
              <p className="text-sm text-black/70 mb-4">
                Crea una sala y define el máximo de participantes. Luego confirma votantes activos.
              </p>
              <button
                onClick={() => setMode("moderator")}
                disabled={!isNameSaved}
                className={`w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white ${
                  isNameSaved ? "bg-primary hover:bg-primary-light" : "bg-gray-400 cursor-not-allowed"
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
                className={`w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white ${
                  isNameSaved ? "bg-secondary hover:opacity-90" : "bg-gray-400 cursor-not-allowed"
                }`}
              >
                Continuar como votante
              </button>
            </section>
          

<section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
  <h3 className="text-base sm:text-lg font-semibold text-primary mb-3">Presentador</h3>
  <p className="text-sm text-black/70 mb-4">
    Vista en pantalla completa para proyectar el código de la sala y la pregunta actual.
  </p>
  <button
    onClick={() => setMode("presenter")}
    className="w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white bg-purple-700 hover:bg-purple-800"
  >
    Continuar como presentador
  </button>
</section></div>
        </main>

        <footer className="bg-primary-dark text-white mt-auto">
          <div className="mx-auto max-w-5xl px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm opacity-90">
            © {new Date().getFullYear()} Mesas de Votación — Votaciones en tiempo real - GRZN 2025.
          </div>
        </footer>

        <Toaster position="top-center" toastOptions={{ duration: 3000 }} />
      </div>
    );
  }

  
// ========= PRESENTER =========
if (mode === "presenter") {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="bg-purple-800 text-white">
        <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 sm:py-4 flex items-center justify-between">
          <h1 className="text-lg sm:text-xl font-bold">Vista de presentador</h1>
          <button
            onClick={() => {
              setMode("home");
              setIsPresenter(false);
            }}
            className="text-xs sm:text-sm underline decoration-white/60 hover:decoration-white"
          >
            ← Volver
          </button>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-5xl px-3 sm:px-4 py-6 sm:py-10">
        <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm max-w-xl mx-auto">
          <h3 className="text-base sm:text-lg font-semibold text-primary mb-4">
            Entrar como presentador
          </h3>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="Código de la sala (ej: ABC12)"
                className="flex-1 rounded-lg border border-black/10 px-3 py-2 uppercase tracking-wider outline-none focus:ring-2 focus:ring-purple-500/30"
              />
              <button
                onClick={joinPresenter}
                className="w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white bg-purple-700 hover:bg-purple-800"
              >
                Entrar
              </button>
            </div>

            <p className="text-sm text-black/70">
              Este rol no vota ni aparece como participante. Es solo para proyección.
            </p>
          </div>
        </section>
      </main>

      <footer className="bg-purple-900 text-white mt-auto">
        <div className="mx-auto max-w-5xl px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm opacity-90">
          © {new Date().getFullYear()} Mesas de Votación — Vista de presentador.
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

        <main className="flex-1 mx-auto max-w-5xl px-3 sm:px-4 py-6 sm:py-10">
          <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm max-w-xl mx-auto">
            <h3 className="text-base sm:text-lg font-semibold text-primary mb-4">
              Configurar sala
            </h3>
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
              </div>

              <button
                onClick={createRoom}
                disabled={!isNameSaved}
                className={`w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white ${
                  isNameSaved ? "bg-primary hover:bg-primary-light" : "bg-gray-400 cursor-not-allowed"
                }`}
              >
                Crear sala
              </button>
            </div>
          </section>
        </main>

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

        <main className="flex-1 mx-auto max-w-5xl px-3 sm:px-4 py-6 sm:py-10">
          <section className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm max-w-xl mx-auto">
            <h3 className="text-base sm:text-lg font-semibold text-primary mb-4">
              Ingresar a una sala
            </h3>
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
                  className={`w-full sm:w-auto rounded-lg px-4 py-2 font-medium text-white ${
                    isNameSaved ? "bg-secondary hover:opacity-90" : "bg-gray-400 cursor-not-allowed"
                  }`}
                >
                  Entrar
                </button>
              </div>

              {/* Delegación de voto */}
              <div className="flex items-center gap-2 mt-2">
                <input
                  id="delegation"
                  type="checkbox"
                  checked={hasDelegation}
                  onChange={(e) => setHasDelegation(e.target.checked)}
                />
                <label htmlFor="delegation" className="text-sm text-black/80">
                  Cuento con delegación de voto
                </label>
              </div>

              {hasDelegation && (
                <input
                  value={delegateName}
                  onChange={(e) => setDelegateName(e.target.value)}
                  placeholder="Nombre de la persona que representas (opcional)"
                  className="rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-primary/30"
                />
              )}
            </div>
          </section>
        </main>

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
