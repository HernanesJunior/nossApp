// ============================================
// N&J — Firebase Configuration & Service Layer
// ============================================

import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

export const firebaseConfig = {
  apiKey: "AIzaSyD7eVaDTD2GylZRqerBLE87ZBrZKI6HffM",
  authDomain: "nj-chat-7d386.firebaseapp.com",
  projectId: "nj-chat-7d386",
  storageBucket: "nj-chat-7d386.firebasestorage.app",
  messagingSenderId: "802103478195",
  appId: "1:802103478195:web:b8213e977f81781ebf2dc6",
  measurementId: "G-VNHDLVC4H3"
};

export const isFirebaseConfigured = () => true;

// Inicialização
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export default app;
