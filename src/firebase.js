// Importar Firebase
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";

// 🔑 Configuración de tu proyecto
const firebaseConfig = {
  apiKey: "AIzaSyDQP0jIG3IqwDfAF1fgE5-vNKPtCZ1J0Ug",
  authDomain: "voterooms-5df69.firebaseapp.com",
  projectId: "voterooms-5df69",
  storageBucket: "voterooms-5df69.firebasestorage.app",
  messagingSenderId: "705392078077",
  appId: "1:705392078077:web:419660aa3d5812200d6294",
  measurementId: "G-0G6R9PE6DV"
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);

// Exportar Firestore
export const db = getFirestore(app);

// Exportar Auth y login anónimo
export const auth = getAuth(app);

// Hacer login anónimo automáticamente
signInAnonymously(auth).catch((err) => {
  console.error("Error en autenticación anónima:", err);
});
