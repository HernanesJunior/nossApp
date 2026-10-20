// ============================================
// N&J — User Authentication & Account Store
// ============================================

import { auth, db, isFirebaseConfigured, isCoupleMember } from './firebase.js';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup
} from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';

const USERS_KEY = 'nj_registered_users';
const SESSION_KEY = 'nj_active_session';

// Retorna todos os usuários cadastrados localmente
export function getRegisteredUsers() {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

// Salva lista de usuários
export function saveRegisteredUsers(users) {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  } catch (e) {
    console.error('Erro ao salvar usuários:', e);
  }
}

// Obtém a sessão atual
export function getActiveSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Salva a sessão ativa
export function setActiveSession(user) {
  if (user) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

// Login com Google
export async function loginWithGoogle() {
  if (!isFirebaseConfigured() || !auth) {
    throw new Error('Configure o Firebase para usar o Login do Google.');
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const result = await signInWithPopup(auth, provider);
  const user = result.user;
  if (!isCoupleMember(user.uid)) {
    await signOut(auth);
    throw new Error('Esta conta não tem autorização para acessar o chat.');
  }

  let photoURL = user.photoURL || null;
  let statusMessage = 'Disponível';

  if (db) {
    try {
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      if (userDoc.exists()) {
        const data = userDoc.data();
        if (data.photoURL) photoURL = data.photoURL;
        if (data.statusMessage) statusMessage = data.statusMessage;
      }
    } catch (e) {
      console.warn('Could not load user doc:', e);
    }

    await setDoc(doc(db, 'users', user.uid), {
      displayName: user.displayName || 'Amor',
      email: user.email,
      photoURL: photoURL,
      statusMessage: statusMessage,
      lastLogin: serverTimestamp()
    }, { merge: true });
  }

  const sessionUser = {
    uid: user.uid,
    displayName: user.displayName || 'Amor',
    email: user.email,
    photoURL: photoURL,
    statusMessage: statusMessage
  };

  setActiveSession(sessionUser);
  return sessionUser;
}

// Função de cadastro por e-mail/senha
export async function registerAccount(name, email, password) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanName = name.trim();

  if (isFirebaseConfigured() && auth) {
    const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
    await updateProfile(cred.user, { displayName: cleanName });
    if (db) {
      await setDoc(doc(db, 'users', cred.user.uid), {
        displayName: cleanName,
        email: cleanEmail,
        statusMessage: 'Disponível',
        photoURL: null,
        createdAt: serverTimestamp()
      });
    }
    const sessionUser = {
      uid: cred.user.uid,
      displayName: cleanName,
      email: cleanEmail,
      photoURL: cred.user.photoURL || null,
      statusMessage: 'Disponível'
    };
    setActiveSession(sessionUser);
    return sessionUser;
  }

  // Modo autônomo local
  const users = getRegisteredUsers();
  const exists = users.find(u => u.email === cleanEmail);
  if (exists) {
    throw new Error('Este email já está cadastrado.');
  }

  const newUser = {
    uid: 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    displayName: cleanName,
    email: cleanEmail,
    password: btoa(password),
    photoURL: null,
    statusMessage: 'Disponível',
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  saveRegisteredUsers(users);

  const sessionUser = {
    uid: newUser.uid,
    displayName: newUser.displayName,
    email: newUser.email,
    photoURL: newUser.photoURL || null,
    statusMessage: newUser.statusMessage || 'Disponível'
  };
  setActiveSession(sessionUser);
  return sessionUser;
}

// Função de login com e-mail/senha
export async function loginAccount(email, password) {
  const cleanEmail = email.toLowerCase().trim();

  if (isFirebaseConfigured() && auth) {
    const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
    if (!isCoupleMember(cred.user.uid)) {
      await signOut(auth);
      throw new Error('Esta conta não tem autorização para acessar o chat.');
    }

    let photoURL = cred.user.photoURL || null;
    let statusMessage = 'Disponível';
    let displayName = cred.user.displayName || 'Amor';

    if (db) {
      try {
        const userDoc = await getDoc(doc(db, 'users', cred.user.uid));
        if (userDoc.exists()) {
          const data = userDoc.data();
          if (data.displayName) displayName = data.displayName;
          if (data.photoURL) photoURL = data.photoURL;
          if (data.statusMessage) statusMessage = data.statusMessage;
        }
      } catch (e) {
        console.warn('Could not read user profile from firestore:', e);
      }
    }

    const sessionUser = {
      uid: cred.user.uid,
      displayName: displayName,
      email: cred.user.email,
      photoURL: photoURL,
      statusMessage: statusMessage
    };
    setActiveSession(sessionUser);
    return sessionUser;
  }

  const users = getRegisteredUsers();
  const found = users.find(u => u.email === cleanEmail);
  if (!found) {
    throw new Error('Usuário não encontrado. Crie sua conta primeiro.');
  }

  if (found.password !== btoa(password)) {
    throw new Error('Senha incorreta.');
  }

  const sessionUser = {
    uid: found.uid,
    displayName: found.displayName,
    email: found.email,
    photoURL: found.photoURL || null,
    statusMessage: found.statusMessage || 'Disponível'
  };
  setActiveSession(sessionUser);
  return sessionUser;
}
