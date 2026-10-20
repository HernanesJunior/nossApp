// ============================================
// N&J — Main Application
// ============================================

import './style.css';
import { auth, db, storage, isFirebaseConfigured, isCoupleMember } from './firebase.js';
import {
  loginAccount,
  loginWithGoogle,
  getActiveSession,
  setActiveSession,
  getRegisteredUsers
} from './auth.js';
import { onAuthStateChanged, signOut, updateProfile } from 'firebase/auth';
import {
  collection,
  addDoc,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  doc,
  updateDoc,
  setDoc
} from 'firebase/firestore';
import {
  ref,
  uploadBytes,
  getDownloadURL
} from 'firebase/storage';
import { icons } from './icons.js';
import { quickReactions, getAllEmojis, searchEmojis } from './emojis.js';

// ============================================
// Broadcast Channel for Local Real-Time Sync
// ============================================
const localChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nj_channel') : null;

// ============================================
// State
// ============================================
const state = {
  isLocalMode: !isFirebaseConfigured(),
  user: null, // { uid, displayName, email, photoURL, statusMessage }
  partner: null, // { uid, displayName, photoURL, statusMessage, online, lastSeen }
  messages: [],
  theme: localStorage.getItem('nj-theme') || 'dark',
  wallpaper: localStorage.getItem('nj-wallpaper') || 'default',
  customWallpaper: localStorage.getItem('nj-custom-wallpaper') || null,
  pinnedMessageId: localStorage.getItem('nj-pinned-msg') || null,
  starredMessageIds: JSON.parse(localStorage.getItem('nj-starred-msgs') || '[]'),
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  recordingSeconds: 0,
  recordingTimer: null,
  showEmojiPicker: false,
  showReactionPicker: null, // messageId
  showSettings: false,
  imageFiles: [],
  typingTimeout: null,
  presenceInterval: null,
  partnerTyping: false,
  searchQuery: '',
  replyTo: null,
  activeMessageActions: null,
  messagePressTimeout: null,
  unsubMessages: null,
  unsubPresence: null,
  unsubTyping: null,
};

// ============================================
// Theme & Wallpaper
// ============================================
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('nj-theme', state.theme);
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  renderSettings();
  const themeBtn = $('#theme-toggle-btn');
  if (themeBtn) themeBtn.innerHTML = state.theme === 'dark' ? icons.sun : icons.moon;
}

function applyWallpaper() {
  const container = $('#messages-container');
  if (container) {
    container.setAttribute('data-wallpaper', state.wallpaper);
    container.style.backgroundImage = state.wallpaper === 'custom' && state.customWallpaper
      ? `url("${state.customWallpaper}")`
      : '';
    container.style.backgroundSize = state.wallpaper === 'custom' ? 'cover' : '';
    container.style.backgroundPosition = state.wallpaper === 'custom' ? 'center' : '';
    container.style.backgroundRepeat = state.wallpaper === 'custom' ? 'no-repeat' : '';
  }
  localStorage.setItem('nj-wallpaper', state.wallpaper);
}

applyTheme();

// ============================================
// Helpers
// ============================================
function $(selector) {
  return document.querySelector(selector);
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  if (isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Hoje';
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function showToast(message) {
  const existing = $('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function getPartnerName() {
  if (state.partner?.displayName) return state.partner.displayName;

  // Encontrar o outro usuário cadastrado
  const users = getRegisteredUsers();
  const other = users.find(u => u.email !== state.user?.email && u.displayName !== state.user?.displayName);
  if (other) return other.displayName;

  const myName = (state.user?.displayName || '').toLowerCase();
  if (myName.includes('junior')) return 'Naftaly 💖';
  if (myName.includes('naftaly')) return 'Junior 💙';

  return 'Naftaly 💖';
}

function getPartnerInitial() {
  const name = getPartnerName();
  return name.charAt(0).toUpperCase();
}

function getPartnerPhotoURL() {
  if (state.partner?.photoURL) return state.partner.photoURL;
  const users = getRegisteredUsers();
  const other = users.find(u => u.email !== state.user?.email && u.displayName !== state.user?.displayName);
  return other?.photoURL || null;
}

function getPartnerStatusMessage() {
  if (state.partner?.statusMessage) return state.partner.statusMessage;
  const users = getRegisteredUsers();
  const other = users.find(u => u.email !== state.user?.email && u.displayName !== state.user?.displayName);
  return other?.statusMessage || 'Disponível';
}

function getUserPhotoURL() {
  return state.user?.photoURL || null;
}

function getUserInitial() {
  return (state.user?.displayName || 'U').charAt(0).toUpperCase();
}

function getUserStatusMessage() {
  return state.user?.statusMessage || 'Disponível';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ============================================
// Storage & Local Sync
// ============================================
function getLocalMessages() {
  try {
    const raw = localStorage.getItem('nj_local_messages');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveLocalMessages(msgs) {
  try {
    localStorage.setItem('nj_local_messages', JSON.stringify(msgs));
  } catch (e) {
    console.warn('Storage limit reached:', e);
  }
}

if (localChannel) {
  localChannel.onmessage = (event) => {
    const { type, data } = event.data;
    if (type === 'NEW_MESSAGE' || type === 'UPDATE_MESSAGE' || type === 'DELETE_MESSAGE') {
      if (state.isLocalMode) {
        state.messages = getLocalMessages();
        if (!document.hidden) markMessagesRead(state.messages);
        renderMessages();
      }
    } else if (type === 'TYPING') {
      if (data.email !== state.user?.email) {
        state.partnerTyping = data.isTyping;
        updateHeaderStatus();
      }
    } else if (type === 'PRESENCE') {
      if (data.email !== state.user?.email) {
        state.partner = {
          displayName: data.displayName,
          photoURL: data.photoURL || null,
          statusMessage: data.statusMessage || 'Disponível',
          email: data.email,
          online: data.online,
          lastSeen: data.lastSeen
        };
        state.partnerTyping = false;
        updateHeaderStatus();
      }
    } else if (type === 'PROFILE_UPDATE') {
      if (data.email !== state.user?.email) {
        if (!state.partner) state.partner = {};
        if (data.photoURL !== undefined) state.partner.photoURL = data.photoURL;
        if (data.displayName !== undefined) state.partner.displayName = data.displayName;
        if (data.statusMessage !== undefined) state.partner.statusMessage = data.statusMessage;
        updateHeaderStatus();
      }
    } else if (type === 'PIN_MESSAGE') {
      state.pinnedMessageId = data.id || null;
      localStorage.setItem('nj-pinned-msg', data.id || '');
      renderPinnedBanner();
    }
  };
}

// ============================================
// Auth & Login / Register Screen
// ============================================
function renderLogin(mode = 'login') {
  const app = $('#app');

  app.innerHTML = `
    <div class="login-screen">
      <div class="login-shell">
        <section class="login-art" aria-label="Uma aventura a dois">
          <div class="login-art-stars" aria-hidden="true"></div>
          <div class="login-planet" aria-hidden="true"></div>
          <div class="login-moon" aria-hidden="true"></div>
          <div class="login-art-brand">
            <span class="login-art-brand-icon">${icons.heart}</span>
            <span>N&J<small>ESPAÇO PARTICULAR</small></span>
          </div>
          <div class="login-art-copy">
            <span>UM UNIVERSO SÓ DE VOCÊS</span>
            <h2>JUNTOS EM<br /><strong>QUALQUER DISTÂNCIA.</strong></h2>
            <p>Seu cantinho para conversar, sorrir e guardar momentos. 💜</p>
          </div>
        </section>

        <section class="login-panel">
          <div class="login-panel-content">
            <div class="login-kicker">BEM-VINDO(A) AO N&J</div>
            <h1 class="login-title">SIGN IN</h1>
            <p class="login-subtitle">Entre com seu e-mail para continuar</p>

            <div class="login-form" id="auth-form-container">
              <div class="login-input-group">
                <input type="email" id="auth-email" placeholder="Seu e-mail" autocomplete="email" aria-label="Seu e-mail" />
              </div>
              <div class="login-input-group">
                <input type="password" id="auth-password" placeholder="Sua senha" autocomplete="current-password" aria-label="Sua senha" />
              </div>

              <p class="login-error" id="auth-error"></p>

              <button type="button" class="login-btn" id="auth-submit-btn">
                Entrar <span aria-hidden="true">→</span>
              </button>
            </div>

            <div class="login-divider"><span>ou continue com</span></div>
            <button type="button" class="login-google-btn" id="google-login-btn">
              <span class="login-google-icon">${icons.google}</span>
              <span>Continuar com Google</span>
            </button>

            <button class="login-firebase-link" id="open-firebase-config">
              ⚙️ ${isFirebaseConfigured() ? 'Firebase conectado' : 'Configurar sincronização em nuvem'}
            </button>
          </div>
        </section>
      </div>
    </div>
  `;

  $('#open-firebase-config').addEventListener('click', () => renderFirebaseModal());

  const googleBtn = $('#google-login-btn');
  const errorEl = $('#auth-error');

  if (googleBtn) {
    googleBtn.addEventListener('click', async () => {
      errorEl.textContent = '';
      googleBtn.disabled = true;
      googleBtn.style.opacity = '0.7';
      try {
        const user = await loginWithGoogle();
        state.user = user;
        showToast(`Bem-vindo(a), ${user.displayName}! 💜`);
        renderChat();
      } catch (err) {
        console.error('Google login error:', err);
        errorEl.textContent = err.message || 'Erro ao entrar com Google.';
        googleBtn.disabled = false;
        googleBtn.style.opacity = '1';
      }
    });
  }
  const submitBtn = $('#auth-submit-btn');

  const doSubmit = async () => {
    errorEl.textContent = '';

    const email = $('#auth-email')?.value.trim();
    const password = $('#auth-password')?.value;

    if (!email || !password) {
      errorEl.textContent = 'Preencha todos os campos.';
      return;
    }

    if (password.length < 6) {
      errorEl.textContent = 'A senha deve ter pelo menos 6 caracteres.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner" style="margin: 0 auto;"></div>';

    try {
      const user = await loginAccount(email, password);
      state.user = user;
      showToast(`Bem-vindo(a) de volta, ${user.displayName}! 💜`);
      renderChat();
    } catch (err) {
      console.error('Auth error:', err);
      errorEl.textContent = err.message || 'Erro ao processar. Verifique os dados.';
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Entrar no Chat 💜';
    }
  };

  submitBtn.addEventListener('click', doSubmit);

  // Allow Enter key to submit on any input
  app.querySelectorAll('#auth-form-container input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSubmit();
    });
  });
}

// ============================================
// Presence & Typing
// ============================================
async function updatePresence(online) {
  if (!state.user) return;

  const photoURL = getUserPhotoURL();
  const statusMessage = getUserStatusMessage();

  if (localChannel) {
    localChannel.postMessage({
      type: 'PRESENCE',
      data: {
        email: state.user.email,
        displayName: state.user.displayName,
        photoURL: photoURL,
        statusMessage: statusMessage,
        online,
        lastSeen: new Date().toISOString()
      }
    });
  }

  if (!state.isLocalMode && db && state.user.uid) {
    await setDoc(doc(db, 'presence', state.user.uid), {
      uid: state.user.uid,
      email: state.user.email,
      displayName: state.user.displayName,
      photoURL: photoURL,
      statusMessage: statusMessage,
      online,
      typing: false,
      lastSeen: serverTimestamp()
    }, { merge: true });
  }
}

async function setTyping(isTyping) {
  if (!state.user) return;

  if (localChannel) {
    localChannel.postMessage({
      type: 'TYPING',
      data: { email: state.user.email, isTyping }
    });
  }

  if (!state.isLocalMode && db && state.user.uid) {
    try {
      await setDoc(doc(db, 'presence', state.user.uid), {
        uid: state.user.uid,
        email: state.user.email,
        displayName: state.user.displayName,
        photoURL: getUserPhotoURL(),
        statusMessage: getUserStatusMessage(),
        online: true,
        typing: isTyping,
        lastSeen: serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error('Typing status update error:', error);
      showToast('Não foi possível atualizar o status de digitação.');
    }
  }
}

function listenPartnerPresence() {
  updatePresence(true).catch((error) => {
    console.error('Presence update error:', error);
    showToast('Não foi possível atualizar sua presença.');
  });

  if (state.isLocalMode || !db || !state.user?.uid) return;

  if (state.unsubPresence) state.unsubPresence();
  state.unsubPresence = onSnapshot(collection(db, 'presence'), (snapshot) => {
    const partnerPresence = snapshot.docs
      .map((presenceDoc) => ({ id: presenceDoc.id, ...presenceDoc.data() }))
      .find((presence) => presence.id !== state.user.uid && presence.email !== state.user.email);

    if (!partnerPresence) {
      state.partner = null;
      state.partnerTyping = false;
      updateHeaderStatus();
      return;
    }

    const lastSeen = partnerPresence.lastSeen?.toDate
      ? partnerPresence.lastSeen.toDate()
      : new Date(partnerPresence.lastSeen || 0);
    const isFresh = !Number.isNaN(lastSeen.getTime()) && Date.now() - lastSeen.getTime() < 60000;
    state.partner = {
      uid: partnerPresence.uid || partnerPresence.id,
      email: partnerPresence.email,
      displayName: partnerPresence.displayName,
      photoURL: partnerPresence.photoURL || null,
      statusMessage: partnerPresence.statusMessage || 'Disponível',
      online: Boolean(partnerPresence.online && isFresh),
      lastSeen: lastSeen.toISOString()
    };
    state.partnerTyping = Boolean(state.partner.online && partnerPresence.typing);
    updateHeaderStatus();
  }, (error) => {
    console.error('Presence listener error:', error);
    showToast('Não foi possível acompanhar a presença do contato.');
  });

  if (state.presenceInterval) clearInterval(state.presenceInterval);
  state.presenceInterval = setInterval(() => {
    if (!document.hidden) {
      updatePresence(true).catch((error) => console.error('Presence heartbeat error:', error));
    }
    updateHeaderStatus();
  }, 25000);
}

function updateHeaderUserAvatar() {
  const btn = $('#header-user-btn');
  if (!btn) return;
  const photo = getUserPhotoURL();
  const initial = getUserInitial();
  if (photo) {
    btn.innerHTML = `<img src="${escapeHtml(photo)}" alt="Meu perfil" /><div class="header-user-camera-badge">${icons.camera}</div>`;
  } else {
    btn.innerHTML = `<span>${escapeHtml(initial)}</span><div class="header-user-camera-badge">${icons.camera}</div>`;
  }
}

function updateHeaderStatus() {
  const statusEl = $('.header-status');
  const dotEl = $('.online-dot');
  if (!statusEl) return;

  const headerName = $('.header-name');
  const avatarInitial = $('.header-avatar-initial');
  if (headerName) headerName.textContent = getPartnerName();
  if (avatarInitial) avatarInitial.textContent = getPartnerInitial();

  const partnerPhoto = getPartnerPhotoURL();
  const avatar = $('.header-avatar');
  if (avatar) {
    const existingImage = avatar.querySelector('img');
    if (partnerPhoto) {
      if (existingImage) {
        existingImage.src = partnerPhoto;
      } else {
        const image = document.createElement('img');
        image.src = partnerPhoto;
        image.alt = '';
        avatar.prepend(image);
      }
      avatar.classList.add('has-photo');
    } else {
      existingImage?.remove();
      avatar.classList.remove('has-photo');
    }
  }

  updateHeaderUserAvatar();

  if (state.partnerTyping) {
    statusEl.textContent = 'digitando...';
    statusEl.classList.add('typing');
  } else if (state.partner?.online) {
    statusEl.textContent = 'online';
    statusEl.classList.remove('typing');
    if (dotEl) dotEl.classList.remove('offline');
  } else {
    const lastSeen = state.partner?.lastSeen ? new Date(state.partner.lastSeen) : null;
    statusEl.textContent = lastSeen && !Number.isNaN(lastSeen.getTime())
      ? `visto por último ${formatTime(lastSeen)}`
      : 'offline';
    statusEl.classList.remove('typing');
    if (dotEl) dotEl.classList.add('offline');
  }
}

// ============================================
// Messages
// ============================================
function listenMessages() {
  if (state.isLocalMode) {
    state.messages = getLocalMessages();
    if (!document.hidden) markMessagesRead(state.messages);
    renderMessages();
    return;
  }

  if (!db) return;

  const q = query(
    collection(db, 'messages'),
    orderBy('createdAt', 'asc')
  );

  state.unsubMessages = onSnapshot(q, (snapshot) => {
    const newMessages = [];
    snapshot.docs.forEach(d => {
      newMessages.push({ id: d.id, ...d.data() });
    });

    state.messages = newMessages;
    if (!document.hidden) markMessagesRead(newMessages);
    renderMessages();
  }, (error) => {
    console.error('Messages listener error:', error);
    showToast('Não foi possível carregar as mensagens.');
  });
}

function markMessagesRead(messages) {
  const unreadMessages = messages.filter((message) =>
    message.senderEmail !== state.user?.email && !message.read
  );
  if (unreadMessages.length === 0) return;

  if (state.isLocalMode || !db) {
    const unreadIds = new Set(unreadMessages.map((message) => message.id));
    const updatedMessages = getLocalMessages().map((message) =>
      unreadIds.has(message.id) ? { ...message, read: true } : message
    );
    saveLocalMessages(updatedMessages);
    state.messages = updatedMessages;
    localChannel?.postMessage({ type: 'UPDATE_MESSAGE', data: { read: true } });
    return;
  }

  unreadMessages.forEach((message) => {
    updateDoc(doc(db, 'messages', message.id), { read: true }).catch((error) => {
      console.error('Read receipt error:', error);
      showToast('Não foi possível confirmar a leitura.');
    });
  });
}

async function sendMessage(text, imageUrl = null, audioUrl = null, attachment = null) {
  if (!text && !imageUrl && !audioUrl && !attachment) return false;

  const newMessage = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    text: String(text || ''),
    imageUrl: imageUrl ? String(imageUrl) : null,
    audioUrl: audioUrl ? String(audioUrl) : null,
    senderEmail: String(state.user?.email || 'anonimo@nj.local'),
    senderName: String(state.user?.displayName || 'Amor'),
    createdAt: new Date().toISOString(),
    read: false,
    reactions: {},
    fileUrl: attachment?.url || null,
    fileName: attachment?.name || null,
    fileType: attachment?.type || null,
    fileSize: attachment?.size || null,
    replyTo: state.replyTo ? { ...state.replyTo } : null
  };

  if (state.isLocalMode || !db) {
    const msgs = getLocalMessages();
    msgs.push(newMessage);
    saveLocalMessages(msgs);
    state.messages = msgs;
    renderMessages();

    if (localChannel) {
      localChannel.postMessage({ type: 'NEW_MESSAGE', data: newMessage });
    }
    setTyping(false);
    return true;
  }

  try {
    await addDoc(collection(db, 'messages'), {
      text: newMessage.text,
      imageUrl: newMessage.imageUrl,
      audioUrl: newMessage.audioUrl,
      fileUrl: newMessage.fileUrl,
      fileName: newMessage.fileName,
      fileType: newMessage.fileType,
      fileSize: newMessage.fileSize,
      senderEmail: newMessage.senderEmail,
      senderName: newMessage.senderName,
      read: false,
      reactions: {},
      replyTo: newMessage.replyTo,
      createdAt: serverTimestamp()
    });
    setTyping(false);
    return true;
  } catch (e) {
    console.error('Send error:', e);
    showToast(`Erro ao enviar: ${e.code || e.message}`);
    return false;
  }
}

async function toggleReaction(messageId, emoji) {
  const msg = state.messages.find(m => m.id === messageId);
  if (!msg) return;

  const reactions = { ...(msg.reactions || {}) };
  const userKey = state.user.email;

  if (reactions[userKey] === emoji) {
    delete reactions[userKey];
  } else {
    reactions[userKey] = emoji;
  }

  if (state.isLocalMode) {
    const msgs = getLocalMessages();
    const target = msgs.find(m => m.id === messageId);
    if (target) {
      target.reactions = reactions;
      saveLocalMessages(msgs);
      state.messages = msgs;
      renderMessages();
      if (localChannel) {
        localChannel.postMessage({ type: 'UPDATE_MESSAGE', data: target });
      }
    }
    state.showReactionPicker = null;
    return;
  }

  try {
    await updateDoc(doc(db, 'messages', messageId), { reactions });
  } catch (e) {
    console.error('Reaction error:', e);
  }

  state.showReactionPicker = null;
  renderMessages();
}

async function editMessage(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || message.senderEmail !== state.user?.email || !message.text) return;

  const editedText = window.prompt('Editar mensagem:', message.text);
  if (editedText === null) return;
  const text = editedText.trim();
  if (!text) {
    showToast('A mensagem não pode ficar vazia.');
    return;
  }

  const changes = { text, editedAt: new Date().toISOString() };
  if (state.isLocalMode || !db) {
    const messages = getLocalMessages();
    const target = messages.find((item) => item.id === messageId);
    if (!target) return;
    Object.assign(target, changes);
    saveLocalMessages(messages);
    state.messages = messages;
    renderMessages();
    localChannel?.postMessage({ type: 'UPDATE_MESSAGE', data: target });
    return;
  }

  try {
    await updateDoc(doc(db, 'messages', messageId), changes);
  } catch (error) {
    console.error('Edit message error:', error);
    showToast(`Erro ao editar: ${error.code || error.message}`);
  }
}

function replyToMessage(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  state.replyTo = {
    id: message.id,
    senderName: message.senderName || 'Contato',
    text: message.text || (message.imageUrl ? '📷 Foto' : message.audioUrl ? '🎤 Áudio' : message.fileName || 'Anexo')
  };
  renderReplyPreview();
  $('#message-input')?.focus();
}

function renderReplyPreview() {
  const preview = $('#reply-preview');
  if (!preview) return;
  if (!state.replyTo) {
    preview.hidden = true;
    preview.innerHTML = '';
    return;
  }

  preview.hidden = false;
  preview.innerHTML = `
    <div class="reply-preview-copy">
      <strong>Respondendo a <span data-reply-sender></span></strong>
      <span data-reply-text></span>
    </div>
    <button type="button" class="reply-preview-close" aria-label="Cancelar resposta">✕</button>
  `;
  preview.querySelector('[data-reply-sender]').textContent = String(state.replyTo.senderName);
  preview.querySelector('[data-reply-text]').textContent = String(state.replyTo.text);
  preview.querySelector('.reply-preview-close').addEventListener('click', () => {
    state.replyTo = null;
    renderReplyPreview();
  });
}

async function deleteMessage(messageId) {
  const msg = state.messages.find(message => message.id === messageId);
  if (!msg || msg.senderEmail !== state.user?.email) return;
  if (!window.confirm('Apagar esta mensagem? Essa ação não pode ser desfeita.')) return;

  if (state.isLocalMode || !db) {
    const messages = getLocalMessages().filter(message => message.id !== messageId);
    saveLocalMessages(messages);
    state.messages = messages;
    renderMessages();
    localChannel?.postMessage({ type: 'DELETE_MESSAGE', data: { id: messageId } });
    return;
  }

  try {
    await deleteDoc(doc(db, 'messages', messageId));
  } catch (e) {
    console.error('Delete message error:', e);
    showToast(`Erro ao apagar: ${e.code || e.message}`);
  }
}

// ============================================
// File Upload & Audio Recording
// ============================================
async function uploadAttachment(file) {
  const safeName = file.name.replace(/[^\w.-]/g, '_');
  if (state.isLocalMode || !storage) {
    return {
      url: await blobToDataURL(file),
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size
    };
  }
  const fileName = `attachments/${Date.now()}_${safeName}`;
  const storageRef = ref(storage, fileName);
  const snapshot = await uploadBytes(storageRef, file, {
    contentType: file.type || 'application/octet-stream'
  });
  return {
    url: await getDownloadURL(snapshot.ref),
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size
  };
}

async function uploadAudio(blob) {
  if (state.isLocalMode || !storage) {
    return await blobToDataURL(blob);
  }
  const fileName = `audio/${Date.now()}.webm`;
  const storageRef = ref(storage, fileName);
  const snapshot = await uploadBytes(storageRef, blob);
  return getDownloadURL(snapshot.ref);
}

async function prepareProfilePhoto(file) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Selecione um arquivo de imagem.');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('A foto deve ter no máximo 10 MB.');
  }

  const source = await blobToDataURL(file);
  const image = new Image();
  image.src = source;
  await image.decode();

  const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Não foi possível preparar a foto.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const photoBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Não foi possível converter a foto.'));
    }, 'image/jpeg', 0.82);
  });

  return { blob: photoBlob, dataUrl: await blobToDataURL(photoBlob) };
}

async function saveProfilePhoto(file) {
  try {
    const { blob, dataUrl } = await prepareProfilePhoto(file);
    let photoURL = dataUrl;

    if (!state.isLocalMode && storage && state.user?.uid) {
      const photoRef = ref(storage, `profiles/${state.user.uid}/${Date.now()}.jpg`);
      const upload = await uploadBytes(photoRef, blob, {
        contentType: 'image/jpeg',
        cacheControl: 'public,max-age=31536000'
      });
      photoURL = await getDownloadURL(upload.ref);

      if (auth.currentUser) {
        await updateProfile(auth.currentUser, { photoURL });
      }
    }

    state.user = { ...state.user, photoURL };
    setActiveSession(state.user);
    const registeredUsers = getRegisteredUsers();
    const localUser = registeredUsers.find((user) => user.uid === state.user.uid);
    if (localUser) {
      localUser.photoURL = photoURL;
      saveRegisteredUsers(registeredUsers);
    }

    if (!state.isLocalMode && db && state.user.uid) {
      try {
        await setDoc(doc(db, 'users', state.user.uid), { photoURL }, { merge: true });
      } catch (error) {
        console.error('Profile photo Firestore sync error:', error);
      }
      updatePresence(true).catch((error) => console.error('Presence sync error:', error));
    }

    if (localChannel) {
      localChannel.postMessage({
        type: 'PROFILE_UPDATE',
        data: {
          email: state.user.email,
          photoURL,
          displayName: state.user.displayName,
          statusMessage: getUserStatusMessage()
        }
      });
    }

    updateHeaderUserAvatar();
    renderMyProfile();
    renderSettings();
    showToast('Foto de perfil atualizada com sucesso! 💜');
  } catch (error) {
    console.error('Profile photo update error:', error);
    showToast(error.message || 'Não foi possível atualizar a foto de perfil.');
  }
}

async function removeProfilePhoto() {
  try {
    state.user = { ...state.user, photoURL: null };
    setActiveSession(state.user);
    const registeredUsers = getRegisteredUsers();
    const localUser = registeredUsers.find((user) => user.uid === state.user.uid);
    if (localUser) {
      localUser.photoURL = null;
      saveRegisteredUsers(registeredUsers);
    }

    if (auth.currentUser) {
      await updateProfile(auth.currentUser, { photoURL: '' });
    }

    if (!state.isLocalMode && db && state.user.uid) {
      try {
        await setDoc(doc(db, 'users', state.user.uid), { photoURL: null }, { merge: true });
      } catch (e) {
        console.error('Firestore photo removal error:', e);
      }
      updatePresence(true).catch((e) => console.error('Presence sync error:', e));
    }

    if (localChannel) {
      localChannel.postMessage({
        type: 'PROFILE_UPDATE',
        data: {
          email: state.user.email,
          photoURL: null,
          displayName: state.user.displayName,
          statusMessage: getUserStatusMessage()
        }
      });
    }

    updateHeaderUserAvatar();
    renderMyProfile();
    renderSettings();
    showToast('Foto de perfil removida.');
  } catch (error) {
    console.error('Error removing profile photo:', error);
    showToast('Não foi possível remover a foto de perfil.');
  }
}

async function updateProfileName(name) {
  const clean = name.trim();
  if (!clean) {
    showToast('O nome não pode estar vazio.');
    return;
  }
  try {
    state.user = { ...state.user, displayName: clean };
    setActiveSession(state.user);
    const registeredUsers = getRegisteredUsers();
    const localUser = registeredUsers.find((user) => user.uid === state.user.uid);
    if (localUser) {
      localUser.displayName = clean;
      saveRegisteredUsers(registeredUsers);
    }
    if (auth.currentUser) {
      await updateProfile(auth.currentUser, { displayName: clean });
    }
    if (!state.isLocalMode && db && state.user.uid) {
      await setDoc(doc(db, 'users', state.user.uid), { displayName: clean }, { merge: true });
      updatePresence(true).catch(e => console.error(e));
    }
    if (localChannel) {
      localChannel.postMessage({
        type: 'PROFILE_UPDATE',
        data: {
          email: state.user.email,
          displayName: clean,
          photoURL: getUserPhotoURL(),
          statusMessage: getUserStatusMessage()
        }
      });
    }
    updateHeaderUserAvatar();
    renderMyProfile();
    renderSettings();
    showToast('Nome atualizado! 💜');
  } catch (err) {
    console.error('Error updating name:', err);
    showToast('Erro ao atualizar nome.');
  }
}

async function updateStatusMessage(status) {
  const clean = status.trim() || 'Disponível';
  try {
    state.user = { ...state.user, statusMessage: clean };
    setActiveSession(state.user);
    const registeredUsers = getRegisteredUsers();
    const localUser = registeredUsers.find((user) => user.uid === state.user.uid);
    if (localUser) {
      localUser.statusMessage = clean;
      saveRegisteredUsers(registeredUsers);
    }
    if (!state.isLocalMode && db && state.user.uid) {
      await setDoc(doc(db, 'users', state.user.uid), { statusMessage: clean }, { merge: true });
      updatePresence(true).catch(e => console.error(e));
    }
    if (localChannel) {
      localChannel.postMessage({
        type: 'PROFILE_UPDATE',
        data: {
          email: state.user.email,
          displayName: state.user.displayName,
          photoURL: getUserPhotoURL(),
          statusMessage: clean
        }
      });
    }
    renderMyProfile();
    showToast('Recado atualizado! ✨');
  } catch (err) {
    console.error('Error updating status message:', err);
    showToast('Erro ao atualizar recado.');
  }
}

function toggleStarMessage(messageId) {
  const idx = state.starredMessageIds.indexOf(messageId);
  if (idx >= 0) {
    state.starredMessageIds.splice(idx, 1);
    showToast('Mensagem desfavoritada');
  } else {
    state.starredMessageIds.push(messageId);
    showToast('Mensagem marcada com estrela! ⭐');
  }
  localStorage.setItem('nj-starred-msgs', JSON.stringify(state.starredMessageIds));
  renderMessages();
}

function togglePinMessage(messageId) {
  if (state.pinnedMessageId === messageId) {
    state.pinnedMessageId = null;
    showToast('Mensagem desafixada do topo');
  } else {
    state.pinnedMessageId = messageId;
    showToast('Mensagem fixada no topo! 📌');
  }
  localStorage.setItem('nj-pinned-msg', state.pinnedMessageId || '');
  if (localChannel) {
    localChannel.postMessage({ type: 'PIN_MESSAGE', data: { id: state.pinnedMessageId } });
  }
  renderPinnedBanner();
  renderMessages();
}

function renderPinnedBanner() {
  const bannerContainer = $('#pinned-banner-container');
  if (!bannerContainer) return;

  if (!state.pinnedMessageId) {
    bannerContainer.innerHTML = '';
    return;
  }

  const pinnedMsg = state.messages.find(m => m.id === state.pinnedMessageId);
  if (!pinnedMsg) {
    bannerContainer.innerHTML = '';
    return;
  }

  const previewText = pinnedMsg.text
    || (pinnedMsg.imageUrl ? '📷 Foto' : pinnedMsg.audioUrl ? '🎤 Áudio' : pinnedMsg.fileName || 'Anexo');

  bannerContainer.innerHTML = `
    <div class="pinned-banner" id="pinned-banner" title="Toque para ver a mensagem">
      <div class="pinned-banner-icon">${icons.pin}</div>
      <div class="pinned-banner-content">
        <span class="pinned-banner-title">Mensagem Fixada · ${escapeHtml(pinnedMsg.senderName || 'Amor')}</span>
        <span class="pinned-banner-text">${escapeHtml(previewText)}</span>
      </div>
      <button type="button" class="pinned-banner-close" id="unpin-btn" title="Desafixar mensagem">${icons.close}</button>
    </div>
  `;

  bannerContainer.querySelector('#pinned-banner').addEventListener('click', (e) => {
    if (e.target.closest('#unpin-btn')) return;
    scrollToMessage(pinnedMsg.id);
  });

  bannerContainer.querySelector('#unpin-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePinMessage(pinnedMsg.id);
  });
}

function scrollToMessage(messageId) {
  const container = $('#messages-container');
  if (!container) return;
  const target = container.querySelector(`[data-msgid="${messageId}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('message-pinned-highlight');
    setTimeout(() => target.classList.remove('message-pinned-highlight'), 2000);
  } else {
    showToast('Mensagem não encontrada nesta visualização.');
  }
}

// WhatsApp Audio Player Logic
let activeAudio = null;

function initAudioPlayers() {
  const container = $('#messages-container');
  if (!container) return;

  container.querySelectorAll('.wa-audio-player').forEach(player => {
    const playBtn = player.querySelector('.wa-audio-play-btn');
    const hiddenAudio = player.querySelector('.wa-hidden-audio');
    const track = player.querySelector('.wa-audio-track');
    const progress = player.querySelector('.wa-audio-progress');
    const timeEl = player.querySelector('.wa-audio-time');
    const speedBtn = player.querySelector('.wa-audio-speed-btn');

    if (!playBtn || !hiddenAudio) return;

    const formatSecs = (s) => {
      if (!s || isNaN(s)) return '0:00';
      const mins = Math.floor(s / 60);
      const secs = Math.floor(s % 60);
      return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    };

    hiddenAudio.onloadedmetadata = () => {
      timeEl.textContent = formatSecs(hiddenAudio.duration);
    };

    hiddenAudio.ontimeupdate = () => {
      if (!hiddenAudio.duration) return;
      const pct = (hiddenAudio.currentTime / hiddenAudio.duration) * 100;
      progress.style.width = `${pct}%`;
      timeEl.textContent = formatSecs(hiddenAudio.currentTime);
    };

    hiddenAudio.onended = () => {
      playBtn.innerHTML = icons.play;
      progress.style.width = '0%';
      timeEl.textContent = formatSecs(hiddenAudio.duration);
      if (activeAudio === hiddenAudio) activeAudio = null;
    };

    playBtn.onclick = (e) => {
      e.stopPropagation();
      if (hiddenAudio.paused) {
        if (activeAudio && activeAudio !== hiddenAudio) {
          activeAudio.pause();
          const otherPlayBtn = activeAudio.parentElement.querySelector('.wa-audio-play-btn');
          if (otherPlayBtn) otherPlayBtn.innerHTML = icons.play;
        }
        hiddenAudio.play();
        playBtn.innerHTML = icons.pause;
        activeAudio = hiddenAudio;
      } else {
        hiddenAudio.pause();
        playBtn.innerHTML = icons.play;
        if (activeAudio === hiddenAudio) activeAudio = null;
      }
    };

    if (track) {
      track.onclick = (e) => {
        e.stopPropagation();
        if (!hiddenAudio.duration) return;
        const rect = track.getBoundingClientRect();
        const clickPos = (e.clientX - rect.left) / rect.width;
        hiddenAudio.currentTime = clickPos * hiddenAudio.duration;
      };
    }

    if (speedBtn) {
      const speeds = [1, 1.5, 2];
      speedBtn.onclick = (e) => {
        e.stopPropagation();
        let cur = parseFloat(speedBtn.dataset.speed || '1');
        let nextIdx = (speeds.indexOf(cur) + 1) % speeds.length;
        let next = speeds[nextIdx];
        speedBtn.dataset.speed = String(next);
        speedBtn.textContent = `${next}x`;
        hiddenAudio.playbackRate = next;
      };
    }
  });
}

// WhatsApp Voice Recording Logic
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.mediaRecorder = new MediaRecorder(stream);
    state.audioChunks = [];
    state.recordingSeconds = 0;

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.audioChunks.push(e.data);
    };

    state.mediaRecorder.onstop = async () => {
      if (state.recordingTimer) clearInterval(state.recordingTimer);
      state.recordingTimer = null;
      stream.getTracks().forEach(t => t.stop());

      if (state.recordingCancelled) {
        state.recordingCancelled = false;
        showToast('Gravação descartada.');
        renderChatInputNormal();
        return;
      }

      showToast('Enviando áudio...');
      const audioBlob = new Blob(state.audioChunks, { type: 'audio/webm' });
      renderChatInputNormal();

      try {
        const url = await uploadAudio(audioBlob);
        const sent = await sendMessage('', null, url);
        if (sent) {
          state.replyTo = null;
          renderReplyPreview();
          showToast('Áudio enviado! 🎤');
        }
      } catch (e) {
        console.error('Audio upload error:', e);
        showToast('Erro ao enviar áudio');
      }
    };

    state.mediaRecorder.start();
    state.isRecording = true;
    renderChatInputRecording();

    state.recordingTimer = setInterval(() => {
      state.recordingSeconds++;
      const timerEl = $('#recording-timer');
      if (timerEl) {
        const m = Math.floor(state.recordingSeconds / 60);
        const s = state.recordingSeconds % 60;
        timerEl.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
      }
    }, 1000);

  } catch (e) {
    console.error('Recording error:', e);
    showToast('Não foi possível acessar o microfone');
  }
}

function stopRecording(cancelled = false) {
  if (state.mediaRecorder && state.isRecording) {
    state.recordingCancelled = cancelled;
    state.mediaRecorder.stop();
    state.isRecording = false;
    if (state.recordingTimer) clearInterval(state.recordingTimer);
    state.recordingTimer = null;
  }
}

function renderChatInputRecording() {
  const container = $('.input-container');
  if (!container) return;
  container.innerHTML = `
    <div class="wa-recording-bar">
      <div class="wa-recording-indicator">
        <div class="wa-mic-pulsing"></div>
        <span>Gravando</span>
      </div>
      <div class="wa-recording-timer" id="recording-timer">0:00</div>
      <div class="wa-recording-actions">
        <button type="button" class="wa-recording-cancel-btn" id="recording-cancel-btn" title="Descartar gravação">${icons.trash}</button>
        <button type="button" class="wa-recording-send-btn" id="recording-send-btn" title="Enviar áudio">${icons.send}</button>
      </div>
    </div>
  `;

  $('#recording-cancel-btn')?.addEventListener('click', () => stopRecording(true));
  $('#recording-send-btn')?.addEventListener('click', () => stopRecording(false));
}

function renderChatInputNormal() {
  const inputArea = $('.chat-input-area');
  if (!inputArea) return;
  const container = inputArea.querySelector('.input-container');
  if (!container) return;

  container.innerHTML = `
    <div class="input-actions-left">
      <button class="input-btn" id="emoji-btn" title="Emoji">${icons.emoji}</button>
      <button class="input-btn" id="image-btn" title="Anexar foto ou arquivo">${icons.attachment}</button>
      <button class="input-btn" id="mic-btn" title="Gravar áudio">${icons.mic}</button>
    </div>
    <textarea class="message-input" id="message-input" placeholder="Digita aqui, amor... 💜" rows="1"></textarea>
    <button class="send-btn" id="send-btn">${icons.send}</button>
  `;

  setupChatInputEvents();
}

// ============================================
// Render: Chat
// ============================================
function renderChat() {
  if (state.unsubMessages) state.unsubMessages();
  if (state.unsubPresence) state.unsubPresence();
  if (state.presenceInterval) clearInterval(state.presenceInterval);
  state.activeMessageActions = null;

  const app = $('#app');
  app.innerHTML = `
    <div class="chat-app">
      <!-- Header -->
      <div class="chat-header">
        <div class="header-contact-trigger" id="contact-info-trigger" title="Toque para ver os dados do contato">
          <div class="header-avatar">
            <span class="header-avatar-initial">${escapeHtml(getPartnerInitial())}</span>
            <div class="online-dot"></div>
          </div>
          <div class="header-info">
            <div class="header-name">${escapeHtml(getPartnerName())}</div>
            <div class="header-status">online</div>
          </div>
        </div>

        <div class="header-actions">
          <button class="header-btn" id="search-btn" title="Pesquisar mensagens" aria-label="Pesquisar mensagens">
            ${icons.search}
          </button>
          <button class="header-btn" id="starred-msgs-btn" title="Mensagens com estrela" aria-label="Mensagens com estrela">
            ${icons.star}
          </button>
          <button class="header-user-btn" id="header-user-btn" title="Meu Perfil (Trocar Foto)" aria-label="Meu Perfil">
            <!-- Rendered by updateHeaderUserAvatar() -->
          </button>
          <div class="wa-menu-container">
            <button class="header-btn" id="overflow-menu-btn" title="Mais opções" aria-label="Mais opções">
              ${icons.moreVertical}
            </button>
            <div class="wa-dropdown-menu" id="overflow-dropdown" hidden>
              <button class="wa-dropdown-item" id="menu-my-profile">
                ${icons.camera}
                <span>Meu Perfil (Foto & Recado)</span>
              </button>
              <button class="wa-dropdown-item" id="menu-contact-info">
                ${icons.info}
                <span>Dados do Contato</span>
              </button>
              <button class="wa-dropdown-item" id="menu-media-gallery">
                ${icons.gallery}
                <span>Mídias e Arquivos</span>
              </button>
              <button class="wa-dropdown-item" id="menu-starred">
                ${icons.star}
                <span>Mensagens Favoritas</span>
              </button>
              <button class="wa-dropdown-item" id="menu-wallpaper">
                ${icons.wallpaper}
                <span>Papel de Parede</span>
              </button>
              <div class="wa-dropdown-divider"></div>
              <button class="wa-dropdown-item" id="menu-theme">
                ${state.theme === 'dark' ? icons.sun : icons.moon}
                <span>${state.theme === 'dark' ? 'Modo Claro' : 'Modo Escuro'}</span>
              </button>
              <button class="wa-dropdown-item" id="menu-settings">
                ${icons.settings}
                <span>Configurações</span>
              </button>
              <button class="wa-dropdown-item" id="menu-logout" style="color: #f87171;">
                ${icons.logout}
                <span>Sair da conta</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Pinned Message Banner -->
      <div id="pinned-banner-container"></div>

      <!-- Search Bar -->
      <div class="chat-search-bar" id="chat-search-bar" hidden>
        <input type="search" id="chat-search-input" placeholder="Pesquisar mensagens..." aria-label="Pesquisar mensagens" />
        <button type="button" id="close-search-btn" aria-label="Fechar pesquisa">✕</button>
      </div>

      <!-- Messages -->
      <div class="chat-messages" id="messages-container" data-wallpaper="${escapeHtml(state.wallpaper)}">
        <div class="empty-state">
          <div class="empty-state-heart">💜</div>
          <h3>Comecem a conversar!</h3>
          <p>Mande a primeira mensagem para o seu amor 💌</p>
        </div>
      </div>

      <!-- Image Preview -->
      <div class="image-preview-bar" id="image-preview-bar" style="display:none;"></div>

      <!-- Input Area -->
      <div class="chat-input-area" style="position: relative;">
        <div class="reply-preview" id="reply-preview" hidden></div>
        <div class="input-container">
          <div class="input-actions-left">
            <button class="input-btn" id="emoji-btn" title="Emoji">${icons.emoji}</button>
            <button class="input-btn" id="image-btn" title="Anexar foto ou arquivo">${icons.attachment}</button>
            <button class="input-btn" id="mic-btn" title="Gravar áudio">${icons.mic}</button>
          </div>
          <textarea class="message-input" id="message-input" placeholder="Digita aqui, amor... 💜" rows="1"></textarea>
          <button class="send-btn" id="send-btn">${icons.send}</button>
        </div>
        <input type="file" id="image-file-input" multiple style="display:none;" />
      </div>
    </div>
  `;

  setupChatEvents();
  listenMessages();
  listenPartnerPresence();
  updateHeaderUserAvatar();
  renderPinnedBanner();
  applyWallpaper();

  document.onvisibilitychange = () => {
    updatePresence(!document.hidden).catch((error) => {
      console.error('Presence update error:', error);
    });
    if (!document.hidden) markMessagesRead(state.messages);
    if (!document.hidden) renderMessages();
  };

  window.onbeforeunload = () => {
    updatePresence(false).catch((error) => console.error('Presence shutdown error:', error));
    setTyping(false);
  };
}

function setupChatEvents() {
  setupChatInputEvents();

  const fileInput = $('#image-file-input');
  const searchBtn = $('#search-btn');
  const searchBar = $('#chat-search-bar');
  const searchInput = $('#chat-search-input');
  const starredBtn = $('#starred-msgs-btn');
  const userProfileBtn = $('#header-user-btn');
  const contactInfoTrigger = $('#contact-info-trigger');
  const overflowMenuBtn = $('#overflow-menu-btn');
  const overflowDropdown = $('#overflow-dropdown');

  searchBtn?.addEventListener('click', () => {
    searchBar.hidden = false;
    searchInput.focus();
  });

  searchInput?.addEventListener('input', () => {
    state.searchQuery = searchInput.value.trim().toLocaleLowerCase('pt-BR');
    renderMessages();
  });

  $('#close-search-btn')?.addEventListener('click', () => {
    state.searchQuery = '';
    searchInput.value = '';
    searchBar.hidden = true;
    renderMessages();
  });

  starredBtn?.addEventListener('click', () => renderStarredModal());
  userProfileBtn?.addEventListener('click', () => renderMyProfile());
  contactInfoTrigger?.addEventListener('click', () => renderContactInfo());

  // Overflow 3-dots Menu
  overflowMenuBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    overflowDropdown.hidden = !overflowDropdown.hidden;
  });

  $('#menu-my-profile')?.addEventListener('click', () => {
    overflowDropdown.hidden = true;
    renderMyProfile();
  });

  $('#menu-contact-info')?.addEventListener('click', () => {
    overflowDropdown.hidden = true;
    renderContactInfo();
  });

  $('#menu-media-gallery')?.addEventListener('click', () => {
    overflowDropdown.hidden = true;
    renderMediaModal();
  });

  $('#menu-starred')?.addEventListener('click', () => {
    overflowDropdown.hidden = true;
    renderStarredModal();
  });

  $('#menu-wallpaper')?.addEventListener('click', () => {
    overflowDropdown.hidden = true;
    renderWallpaperModal();
  });

  $('#menu-theme')?.addEventListener('click', () => {
    overflowDropdown.hidden = true;
    toggleTheme();
  });

  $('#menu-settings')?.addEventListener('click', () => {
    overflowDropdown.hidden = true;
    state.showSettings = true;
    renderSettings();
  });

  $('#menu-logout')?.addEventListener('click', () => {
    overflowDropdown.hidden = true;
    logoutUser();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.wa-menu-container') && overflowDropdown) {
      overflowDropdown.hidden = true;
    }

    const clickedMessage = e.target.closest('.message-row');
    if (state.activeMessageActions && clickedMessage?.dataset.msgid !== state.activeMessageActions) {
      setActiveMessageActions(null);
    }

    if (state.showEmojiPicker && !e.target.closest('.emoji-picker-modal') && !e.target.closest('#emoji-btn')) {
      state.showEmojiPicker = false;
      const picker = $('.emoji-picker-modal');
      if (picker) picker.remove();
    }

    if (state.showReactionPicker && !e.target.closest('.reaction-picker') && !e.target.closest('.emoji-react-btn')) {
      state.showReactionPicker = null;
      const picker = $('.reaction-picker');
      if (picker) picker.remove();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.querySelector('.wa-modal-overlay');
      if (modal) modal.remove();
      const settings = document.querySelector('.settings-overlay');
      if (settings) {
        state.showSettings = false;
        renderSettings();
      }
      const searchBar = $('#chat-search-bar');
      if (searchBar && !searchBar.hidden) {
        state.searchQuery = '';
        $('#chat-search-input').value = '';
        searchBar.hidden = true;
        renderMessages();
      }
      if (overflowDropdown) overflowDropdown.hidden = true;
      setActiveMessageActions(null);
    }
  });
}

function setupChatInputEvents() {
  const input = $('#message-input');
  const sendBtn = $('#send-btn');
  const emojiBtn = $('#emoji-btn');
  const imageBtn = $('#image-btn');
  const micBtn = $('#mic-btn');
  const fileInput = $('#image-file-input');

  if (!input) return;

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';

    setTyping(true);
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => setTyping(false), 2000);
  });

  sendBtn?.addEventListener('click', handleSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  emojiBtn?.addEventListener('click', () => {
    state.showEmojiPicker = !state.showEmojiPicker;
    if (state.showEmojiPicker) {
      renderEmojiPicker();
    } else {
      const picker = $('.emoji-picker-modal');
      if (picker) picker.remove();
    }
  });

  imageBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', handleImageSelect);

  micBtn?.addEventListener('click', () => {
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });
}

async function handleSend() {
  const input = $('#message-input');
  if (!input) return;
  const text = input.value.trim();

  if (state.isRecording) {
    stopRecording();
    return;
  }

  if (state.imageFiles.length > 0) {
    showToast('Enviando anexos...');
    let sentText = false;
    for (const file of [...state.imageFiles]) {
      try {
        const attachment = await uploadAttachment(file);
        const imageUrl = file.type.startsWith('image/') ? attachment.url : null;
        const messageSent = await sendMessage(
          text && !sentText ? text : '',
          imageUrl,
          null,
          imageUrl ? null : attachment
        );
        if (messageSent) {
          sentText = sentText || Boolean(text);
          state.imageFiles = state.imageFiles.filter((pendingFile) => pendingFile !== file);
          if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
          if (state.replyTo) state.replyTo = null;
        }
      } catch (error) {
        console.error('Attachment upload error:', error);
        showToast(`Erro ao enviar ${file.name}: ${error.message}`);
      }
    }
    renderImagePreview();
    if (sentText) {
      input.value = '';
      input.style.height = 'auto';
    }
    renderReplyPreview();
    return;
  }

  if (!text) return;

  if (await sendMessage(text)) {
    input.value = '';
    input.style.height = 'auto';
    state.replyTo = null;
    renderReplyPreview();
  }
}

function handleImageSelect(e) {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  const maxSize = state.isLocalMode ? 2 * 1024 * 1024 : 25 * 1024 * 1024;
  const acceptedFiles = files.filter((file) => {
    if (file.size > maxSize) {
      showToast(`${file.name} excede o limite de ${state.isLocalMode ? '2 MB' : '25 MB'}.`);
      return false;
    }
    file.previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    return true;
  });
  state.imageFiles = [...state.imageFiles, ...acceptedFiles];
  renderImagePreview();
  e.target.value = '';
}

function renderImagePreview() {
  const bar = $('#image-preview-bar');
  if (!bar) return;

  if (state.imageFiles.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  bar.style.display = 'flex';
  bar.innerHTML = state.imageFiles.map((file, i) => `
    <div class="image-preview-item">
      ${file.previewUrl
        ? `<img src="${file.previewUrl}" alt="Prévia de ${escapeHtml(file.name)}" />`
        : `<span class="file-preview-icon">📎</span>`}
      <span class="file-preview-name">${escapeHtml(file.name)}</span>
      <div class="image-preview-remove" data-index="${i}">✕</div>
    </div>
  `).join('');

  bar.querySelectorAll('.image-preview-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      const [removedFile] = state.imageFiles.splice(idx, 1);
      if (removedFile?.previewUrl) URL.revokeObjectURL(removedFile.previewUrl);
      renderImagePreview();
    });
  });
}

// ============================================
// Render: Messages (WhatsApp Enhanced)
// ============================================
function renderMessages() {
  const container = $('#messages-container');
  if (!container) return;

  renderPinnedBanner();

  const visibleMessages = state.messages.filter((message) => {
    if (!state.searchQuery) return true;
    const searchableText = [
      message.text,
      message.senderName,
      message.fileName,
      message.replyTo?.text
    ].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR');
    return searchableText.includes(state.searchQuery);
  });

  if (visibleMessages.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-heart">💜</div>
        <h3>${state.searchQuery ? 'Nenhuma mensagem encontrada' : 'Comecem a conversar!'}</h3>
        <p>${state.searchQuery ? 'Tente buscar por outro termo.' : 'Mande a primeira mensagem para o seu amor 💌'}</p>
      </div>
    `;
    return;
  }

  let html = '';
  let lastDate = '';

  visibleMessages.forEach((msg, messageIndex) => {
    const msgDate = formatDate(msg.createdAt);
    if (msgDate && msgDate !== lastDate) {
      lastDate = msgDate;
      html += `<div class="date-divider"><span>${msgDate}</span></div>`;
    }

    const isSent = msg.senderEmail === state.user.email;
    const direction = isSent ? 'sent' : 'received';
    const isStarred = state.starredMessageIds.includes(msg.id);
    const isPinned = state.pinnedMessageId === msg.id;

    let reactionsHtml = '';
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
      const reactionCounts = {};
      Object.entries(msg.reactions).forEach(([userEmail, emoji]) => {
        if (!reactionCounts[emoji]) reactionCounts[emoji] = { count: 0, mine: false };
        reactionCounts[emoji].count++;
        if (userEmail === state.user.email) reactionCounts[emoji].mine = true;
      });

      reactionsHtml = '<div class="message-reactions">';
      Object.entries(reactionCounts).forEach(([emoji, data]) => {
        reactionsHtml += `<span class="reaction-badge${data.mine ? ' mine' : ''}" data-msgid="${msg.id}" data-emoji="${emoji}">${emoji}${data.count > 1 ? ` ${data.count}` : ''}</span>`;
      });
      reactionsHtml += '</div>';
    }

    let statusIcon = '';
    if (isSent) {
      statusIcon = msg.read
        ? `<span class="message-check read" title="Lida" style="color:#60a5fa; font-weight:700;">✓✓</span>`
        : `<span class="message-check" title="Entregue">✓✓</span>`;
    }

    let contentHtml = '';
    if (msg.replyTo) {
      contentHtml += `
        <div class="message-quote">
          <strong data-reply-sender></strong>
          <span data-reply-text></span>
        </div>
      `;
    }
    if (msg.imageUrl) {
      const imageUrl = escapeHtml(msg.imageUrl);
      contentHtml += `<img class="message-image" src="${imageUrl}" alt="foto" data-src="${imageUrl}" />`;
    }
    if (msg.audioUrl) {
      const audioUrl = escapeHtml(msg.audioUrl);
      contentHtml += `
        <div class="wa-audio-player" data-audio-id="audio_${msg.id}">
          <button type="button" class="wa-audio-play-btn" data-url="${audioUrl}" data-msgid="${msg.id}" title="Reproduzir áudio">
            ${icons.play}
          </button>
          <div class="wa-audio-body">
            <div class="wa-audio-track" data-msgid="${msg.id}">
              <div class="wa-audio-progress" style="width: 0%;">
                <div class="wa-audio-thumb"></div>
              </div>
            </div>
            <div class="wa-audio-meta">
              <span class="wa-audio-time">0:00</span>
              <button type="button" class="wa-audio-speed-btn" data-msgid="${msg.id}" data-speed="1" title="Velocidade">1x</button>
            </div>
          </div>
          <audio class="wa-hidden-audio" preload="metadata" src="${audioUrl}"></audio>
        </div>
      `;
    }
    if (msg.fileUrl && msg.fileName) {
      contentHtml += `
        <a class="message-file" href="${escapeHtml(msg.fileUrl)}" target="_blank" rel="noopener noreferrer" download="${escapeHtml(msg.fileName)}">
          <span>📎</span>
          <span>${escapeHtml(msg.fileName)}<small>${msg.fileSize ? `${Math.max(1, Math.round(msg.fileSize / 1024))} KB` : 'Arquivo'}</small></span>
        </a>
      `;
    }
    if (msg.text) {
      contentHtml += '<span class="message-text"></span>';
    }

    const actionsHtml = `
      <div class="wa-context-menu"${state.activeMessageActions === msg.id ? '' : ' hidden'}>
        <button class="wa-context-btn" data-action="reply" data-msgid="${msg.id}" title="Responder">${icons.reply}</button>
        ${msg.text ? `<button class="wa-context-btn" data-action="copy" data-msgid="${msg.id}" title="Copiar texto">${icons.copy}</button>` : ''}
        <button class="wa-context-btn ${isStarred ? 'star-active' : ''}" data-action="star" data-msgid="${msg.id}" title="${isStarred ? 'Remover estrela' : 'Favoritar com estrela'}">
          ${isStarred ? icons.starFilled : icons.star}
        </button>
        <button class="wa-context-btn ${isPinned ? 'pin-active' : ''}" data-action="pin" data-msgid="${msg.id}" title="${isPinned ? 'Desafixar' : 'Fixar no topo'}">
          ${icons.pin}
        </button>
        ${isSent && msg.text ? `<button class="wa-context-btn" data-action="edit" data-msgid="${msg.id}" title="Editar">${icons.edit}</button>` : ''}
        ${isSent ? `<button class="wa-context-btn danger" data-action="delete" data-msgid="${msg.id}" title="Apagar">${icons.trash}</button>` : ''}
      </div>
    `;

    html += `
      <div class="message-row ${direction}${state.activeMessageActions === msg.id ? ' actions-visible' : ''}" data-msgid="${msg.id}" data-render-index="${messageIndex}">
        <div class="message-bubble">
          <button class="emoji-react-btn" data-msgid="${msg.id}">😊</button>
          ${actionsHtml}
          ${contentHtml}
          ${reactionsHtml}
        </div>
        <div class="message-meta">
          <span>${formatTime(msg.createdAt)}</span>
          ${msg.editedAt ? '<span>· editada</span>' : ''}
          ${isStarred ? `<span class="starred-star-badge" title="Mensagem com estrela">★</span>` : ''}
          ${statusIcon}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  container.querySelectorAll('.message-row[data-render-index]').forEach((row) => {
    const message = visibleMessages[Number(row.dataset.renderIndex)];
    if (!message) return;

    const messageText = row.querySelector('.message-text');
    if (messageText) messageText.textContent = String(message.text || '');

    if (message.replyTo) {
      const replySender = row.querySelector('[data-reply-sender]');
      const replyText = row.querySelector('[data-reply-text]');
      if (replySender) replySender.textContent = String(message.replyTo.senderName || 'Contato');
      if (replyText) replyText.textContent = String(message.replyTo.text || 'Mensagem');
    }
  });

  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });

  initAudioPlayers();

  container.querySelectorAll('.reaction-badge').forEach(badge => {
    badge.addEventListener('click', () => {
      toggleReaction(badge.dataset.msgid, badge.dataset.emoji);
    });
  });

  container.querySelectorAll('.emoji-react-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const msgId = btn.dataset.msgid;
      if (state.showReactionPicker === msgId) {
        state.showReactionPicker = null;
        const existing = document.querySelector('.reaction-picker');
        if (existing) existing.remove();
      } else {
        state.showReactionPicker = msgId;
        renderReactionPicker(btn, msgId);
      }
    });
  });

  // Floating Context Menu Actions
  container.querySelectorAll('.wa-context-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const msgId = btn.dataset.msgid;
      const msg = state.messages.find(m => m.id === msgId);

      if (action === 'reply') {
        replyToMessage(msgId);
      } else if (action === 'copy') {
        if (msg?.text) {
          navigator.clipboard.writeText(msg.text).then(() => {
            showToast('Mensagem copiada para a área de transferência! 📋');
          }).catch(() => {
            showToast('Não foi possível copiar');
          });
        }
      } else if (action === 'star') {
        toggleStarMessage(msgId);
      } else if (action === 'pin') {
        togglePinMessage(msgId);
      } else if (action === 'edit') {
        editMessage(msgId);
      } else if (action === 'delete') {
        deleteMessage(msgId);
      }
      setActiveMessageActions(null);
    });
  });

  container.querySelectorAll('.message-image').forEach(img => {
    img.addEventListener('click', () => {
      openLightbox(img.dataset.src);
    });
  });

  container.querySelectorAll('.message-bubble').forEach((bubble) => {
    let startX = 0;
    let startY = 0;
    const row = bubble.closest('.message-row');

    bubble.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a, audio, input, .wa-audio-player')) return;
      startX = event.clientX;
      startY = event.clientY;
      clearTimeout(state.messagePressTimeout);
      state.messagePressTimeout = setTimeout(() => {
        setActiveMessageActions(row.dataset.msgid);
      }, 400);
    });

    bubble.addEventListener('pointermove', (event) => {
      if (Math.abs(event.clientX - startX) > 12 || Math.abs(event.clientY - startY) > 12) {
        clearTimeout(state.messagePressTimeout);
      }
    });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
      bubble.addEventListener(eventName, () => clearTimeout(state.messagePressTimeout));
    });

    bubble.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      setActiveMessageActions(row.dataset.msgid);
    });
  });
}

function setActiveMessageActions(messageId) {
  state.activeMessageActions = messageId;
  document.querySelectorAll('.message-row').forEach((row) => {
    const isActive = row.dataset.msgid === messageId;
    row.classList.toggle('actions-visible', isActive);
    const actions = row.querySelector('.wa-context-menu');
    if (actions) actions.hidden = !isActive;
  });
}

function renderReactionPicker(anchorEl, messageId) {
  const existing = document.querySelector('.reaction-picker');
  if (existing) existing.remove();

  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.innerHTML = quickReactions.map(emoji =>
    `<button data-emoji="${emoji}">${emoji}</button>`
  ).join('');

  anchorEl.parentElement.appendChild(picker);

  picker.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleReaction(messageId, btn.dataset.emoji);
      picker.remove();
    });
  });
}

// ============================================
// Render: Emoji Picker
// ============================================
function renderEmojiPicker() {
  const existing = $('.emoji-picker-modal');
  if (existing) existing.remove();

  const allEmojis = getAllEmojis();

  const picker = document.createElement('div');
  picker.className = 'emoji-picker-modal';
  picker.innerHTML = `
    <div class="emoji-picker-header">
      <input type="text" class="emoji-picker-search" placeholder="Buscar emoji..." />
    </div>
    <div class="emoji-picker-grid">
      ${allEmojis.map(e => `<button data-emoji="${e}">${e}</button>`).join('')}
    </div>
  `;

  const inputArea = $('.chat-input-area');
  inputArea.appendChild(picker);

  const searchInput = picker.querySelector('.emoji-picker-search');
  searchInput.addEventListener('input', () => {
    const results = searchEmojis(searchInput.value);
    const grid = picker.querySelector('.emoji-picker-grid');
    grid.innerHTML = results.map(e => `<button data-emoji="${e}">${e}</button>`).join('');
    attachEmojiEvents(grid);
  });

  attachEmojiEvents(picker.querySelector('.emoji-picker-grid'));
}

function attachEmojiEvents(grid) {
  grid.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $('#message-input');
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const emoji = btn.dataset.emoji;
      input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
      input.focus();
      input.selectionStart = input.selectionEnd = start + emoji.length;

      state.showEmojiPicker = false;
      const picker = $('.emoji-picker-modal');
      if (picker) picker.remove();
    });
  });
}

// ============================================
// Lightbox
// ============================================
function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `
    <button class="lightbox-close">✕</button>
    <img src="${src}" alt="foto ampliada" />
  `;

  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// ============================================
// WhatsApp: Meu Perfil (Troca de Foto & Recado)
// ============================================
function renderMyProfile() {
  const existing = $('.wa-modal-overlay');
  if (existing) existing.remove();

  const userPhoto = getUserPhotoURL();
  const userName = state.user?.displayName || 'Você';
  const userEmail = state.user?.email || '';
  const userStatus = getUserStatusMessage();

  const modal = document.createElement('div');
  modal.className = 'wa-modal-overlay';
  modal.innerHTML = `
    <div class="wa-modal-card">
      <div class="wa-modal-header">
        <h3 class="wa-modal-title">${icons.camera} <span>Meu Perfil</span></h3>
        <button class="wa-modal-close" id="close-profile-modal">${icons.close}</button>
      </div>

      <div class="wa-modal-body">
        <!-- Avatar Section with Camera Overlay -->
        <div class="profile-avatar-center">
          <div class="profile-avatar-wrapper" id="profile-photo-trigger" title="Clique para trocar foto de perfil">
            <div class="profile-avatar-img-box">
              ${userPhoto
                ? `<img src="${escapeHtml(userPhoto)}" alt="${escapeHtml(userName)}" />`
                : `<span>${escapeHtml(getUserInitial())}</span>`}
            </div>
            <div class="profile-camera-overlay">
              ${icons.camera}
              <span>Trocar</span>
            </div>
          </div>

          <div class="profile-avatar-actions">
            <button type="button" class="profile-action-btn primary" id="btn-choose-gallery">
              ${icons.gallery}
              <span>Galeria / Arquivo</span>
            </button>
            <button type="button" class="profile-action-btn" id="btn-take-camera">
              ${icons.camera}
              <span>Tirar Foto</span>
            </button>
            ${userPhoto ? `
              <button type="button" class="profile-action-btn danger" id="btn-remove-photo">
                ${icons.trash}
                <span>Remover</span>
              </button>
              <button type="button" class="profile-action-btn" id="btn-view-large">
                <span>🔍 Ver foto</span>
              </button>
            ` : ''}
          </div>

          <input type="file" id="modal-photo-file" accept="image/*" style="display:none;" />
          <input type="file" id="modal-photo-camera" accept="image/*" capture="user" style="display:none;" />
        </div>

        <!-- Name Editor -->
        <div class="profile-card-group">
          <div class="profile-field-row">
            <div class="profile-field-label">
              <span>Seu Nome</span>
              <span style="font-size: 0.7rem; color: var(--text-tertiary);">Como seu amor te vê</span>
            </div>
            <div class="profile-field-input-box">
              <input type="text" class="profile-field-input" id="profile-name-input" value="${escapeHtml(userName)}" maxlength="30" />
              <button type="button" class="profile-field-save-btn" id="profile-name-save">Salvar</button>
            </div>
          </div>
        </div>

        <!-- Status / Recado Editor (WhatsApp Style) -->
        <div class="profile-card-group">
          <div class="profile-field-row">
            <div class="profile-field-label">
              <span>Recado (Status estilo WhatsApp)</span>
            </div>
            <div class="profile-field-input-box">
              <input type="text" class="profile-field-input" id="profile-status-input" value="${escapeHtml(userStatus)}" maxlength="70" placeholder="Digite uma frase ou recado..." />
              <button type="button" class="profile-field-save-btn" id="profile-status-save">Salvar</button>
            </div>

            <div class="profile-chips-title">Sugestões rápidas de recado:</div>
            <div class="profile-chips-grid">
              <button type="button" class="profile-chip" data-status="Disponível">Disponível</button>
              <button type="button" class="profile-chip" data-status="Ocupado(a)">Ocupado(a)</button>
              <button type="button" class="profile-chip" data-status="Com meu amor 💜">Com meu amor 💜</button>
              <button type="button" class="profile-chip" data-status="No trabalho">No trabalho</button>
              <button type="button" class="profile-chip" data-status="Só chamadas urgentes">Só chamadas urgentes</button>
              <button type="button" class="profile-chip" data-status="Amando cada momento ✨">Amando cada momento ✨</button>
              <button type="button" class="profile-chip" data-status="Dormindo 😴">Dormindo 😴</button>
            </div>
          </div>
        </div>

        <!-- Account Info -->
        <div class="profile-card-group" style="font-size: 0.85rem; color: var(--text-secondary);">
          <div><strong>E-mail:</strong> ${escapeHtml(userEmail)}</div>
          <div style="font-size: 0.78rem; color: var(--text-tertiary); margin-top: 4px;">Sua conta e foto sincronizam em tempo real entre celulares.</div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const fileInput = modal.querySelector('#modal-photo-file');
  const cameraInput = modal.querySelector('#modal-photo-camera');

  modal.querySelector('#close-profile-modal')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('#profile-photo-trigger')?.addEventListener('click', () => fileInput.click());
  modal.querySelector('#btn-choose-gallery')?.addEventListener('click', () => fileInput.click());
  modal.querySelector('#btn-take-camera')?.addEventListener('click', () => cameraInput.click());

  [fileInput, cameraInput].forEach(inp => {
    inp.addEventListener('change', async () => {
      const [file] = inp.files || [];
      if (file) {
        showToast('Preparando sua foto...');
        await saveProfilePhoto(file);
      }
      inp.value = '';
    });
  });

  modal.querySelector('#btn-remove-photo')?.addEventListener('click', async () => {
    if (confirm('Deseja remover sua foto de perfil?')) {
      await removeProfilePhoto();
    }
  });

  modal.querySelector('#btn-view-large')?.addEventListener('click', () => {
    if (userPhoto) openLightbox(userPhoto);
  });

  modal.querySelector('#profile-name-save')?.addEventListener('click', () => {
    const val = modal.querySelector('#profile-name-input').value;
    updateProfileName(val);
  });

  modal.querySelector('#profile-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      updateProfileName(e.target.value);
    }
  });

  modal.querySelector('#profile-status-save')?.addEventListener('click', () => {
    const val = modal.querySelector('#profile-status-input').value;
    updateStatusMessage(val);
  });

  modal.querySelector('#profile-status-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      updateStatusMessage(e.target.value);
    }
  });

  modal.querySelectorAll('.profile-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const status = chip.dataset.status;
      modal.querySelector('#profile-status-input').value = status;
      updateStatusMessage(status);
    });
  });
}

// ============================================
// WhatsApp: Dados do Contato
// ============================================
function renderContactInfo() {
  const existing = $('.wa-modal-overlay');
  if (existing) existing.remove();

  const partnerPhoto = getPartnerPhotoURL();
  const partnerName = getPartnerName();
  const partnerStatus = getPartnerStatusMessage();
  const isOnline = Boolean(state.partner?.online);
  const totalMsgs = state.messages.length;
  const mediaCount = state.messages.filter(m => m.imageUrl || m.fileUrl || m.audioUrl).length;
  const starredCount = state.starredMessageIds.length;

  const modal = document.createElement('div');
  modal.className = 'wa-modal-overlay';
  modal.innerHTML = `
    <div class="wa-modal-card">
      <div class="wa-modal-header">
        <h3 class="wa-modal-title">${icons.info} <span>Dados do Contato</span></h3>
        <button class="wa-modal-close" id="close-contact-modal">${icons.close}</button>
      </div>

      <div class="wa-modal-body">
        <div class="profile-avatar-center">
          <div class="profile-avatar-wrapper" id="partner-photo-zoom" style="cursor: pointer;" title="Clique para ampliar">
            <div class="profile-avatar-img-box">
              ${partnerPhoto
                ? `<img src="${escapeHtml(partnerPhoto)}" alt="${escapeHtml(partnerName)}" />`
                : `<span>${escapeHtml(getPartnerInitial())}</span>`}
            </div>
            ${partnerPhoto ? `<div class="profile-camera-overlay">${icons.search}<span>Ampliar</span></div>` : ''}
          </div>
          <h2 style="margin-top: 14px; font-family: var(--font-display); font-size: 1.35rem; font-weight: 700;">
            ${escapeHtml(partnerName)}
          </h2>
          <div style="font-size: 0.85rem; color: ${isOnline ? '#22c55e' : 'var(--text-secondary)'}; font-weight: 500; display: flex; align-items: center; gap: 6px; margin-top: 4px;">
            <div style="width: 8px; height: 8px; border-radius: 50%; background: ${isOnline ? '#22c55e' : '#6b7280'};"></div>
            <span>${isOnline ? 'Online agora' : (state.partner?.lastSeen ? `Visto por último ${formatTime(new Date(state.partner.lastSeen))}` : 'Offline')}</span>
          </div>
        </div>

        <div class="profile-card-group">
          <div class="profile-field-label">Recado</div>
          <div style="font-size: 0.95rem; color: var(--text-primary); line-height: 1.4; padding: 4px 0;">
            ${escapeHtml(partnerStatus)}
          </div>
        </div>

        <div class="contact-stats-grid">
          <div class="contact-stat-card">
            <span class="contact-stat-num">${totalMsgs}</span>
            <span class="contact-stat-label">Mensagens</span>
          </div>
          <div class="contact-stat-card" id="card-open-media" style="cursor: pointer;">
            <span class="contact-stat-num">${mediaCount}</span>
            <span class="contact-stat-label">Mídias 🖼️</span>
          </div>
          <div class="contact-stat-card" id="card-open-starred" style="cursor: pointer;">
            <span class="contact-stat-num">${starredCount}</span>
            <span class="contact-stat-label">Favoritas ⭐</span>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          <button type="button" class="profile-action-btn primary" id="contact-open-media-btn" style="justify-content: center; width: 100%;">
            ${icons.gallery}
            <span>Ver mídias, links e docs (${mediaCount})</span>
          </button>
          <button type="button" class="profile-action-btn" id="contact-open-starred-btn" style="justify-content: center; width: 100%;">
            ${icons.star}
            <span>Mensagens com estrela (${starredCount})</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#close-contact-modal')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('#partner-photo-zoom')?.addEventListener('click', () => {
    if (partnerPhoto) openLightbox(partnerPhoto);
  });

  const openMedia = () => {
    modal.remove();
    renderMediaModal();
  };
  modal.querySelector('#contact-open-media-btn')?.addEventListener('click', openMedia);
  modal.querySelector('#card-open-media')?.addEventListener('click', openMedia);

  const openStarred = () => {
    modal.remove();
    renderStarredModal();
  };
  modal.querySelector('#contact-open-starred-btn')?.addEventListener('click', openStarred);
  modal.querySelector('#card-open-starred')?.addEventListener('click', openStarred);
}

// ============================================
// WhatsApp: Mensagens Favoritas (⭐ Starred)
// ============================================
function renderStarredModal() {
  const existing = $('.wa-modal-overlay');
  if (existing) existing.remove();

  const starredList = state.messages.filter(m => state.starredMessageIds.includes(m.id));

  const modal = document.createElement('div');
  modal.className = 'wa-modal-overlay';
  modal.innerHTML = `
    <div class="wa-modal-card">
      <div class="wa-modal-header">
        <h3 class="wa-modal-title">${icons.starFilled} <span>Mensagens Favoritas (${starredList.length})</span></h3>
        <button class="wa-modal-close" id="close-starred-modal">${icons.close}</button>
      </div>

      <div class="wa-modal-body">
        ${starredList.length === 0 ? `
          <div class="empty-state" style="padding: 24px 0;">
            <div style="font-size: 3rem; margin-bottom: 8px;">⭐</div>
            <p>Nenhuma mensagem marcada com estrela ainda.<br />No chat, toque em qualquer mensagem e clique em <strong>⭐ Favoritar</strong> para salvá-la aqui.</p>
          </div>
        ` : `
          <div class="starred-list">
            ${starredList.map((msg, index) => `
              <div class="starred-card" data-msgid="${msg.id}" data-render-index="${index}" title="Clique para ir até a mensagem">
                <div class="starred-card-top">
                  <span class="starred-card-sender">${escapeHtml(msg.senderName || 'Amor')}</span>
                  <span>${formatTime(msg.createdAt)} · ${formatDate(msg.createdAt)}</span>
                </div>
                <div class="starred-card-content">
                  ${msg.imageUrl ? `<img src="${escapeHtml(msg.imageUrl)}" style="max-height: 80px; border-radius: 6px; margin-bottom: 4px;" alt="foto" /><br />` : ''}
                  ${msg.audioUrl ? `<span>🎤 Mensagem de áudio</span><br />` : ''}
                  ${msg.fileName ? `<span>📎 ${escapeHtml(msg.fileName)}</span><br />` : ''}
                  ${msg.text ? '<span class="starred-card-message-text"></span>' : ''}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelectorAll('.starred-card[data-render-index]').forEach((card) => {
    const message = starredList[Number(card.dataset.renderIndex)];
    const messageText = card.querySelector('.starred-card-message-text');
    if (message && messageText) messageText.textContent = String(message.text || '');
  });

  modal.querySelector('#close-starred-modal')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelectorAll('.starred-card').forEach(card => {
    card.addEventListener('click', () => {
      const msgId = card.dataset.msgid;
      modal.remove();
      scrollToMessage(msgId);
    });
  });
}

// ============================================
// WhatsApp: Mídias Compartilhadas
// ============================================
function renderMediaModal(activeTab = 'photos') {
  const existing = $('.wa-modal-overlay');
  if (existing) existing.remove();

  const photos = state.messages.filter(m => m.imageUrl);
  const audios = state.messages.filter(m => m.audioUrl);
  const files = state.messages.filter(m => m.fileUrl);

  const modal = document.createElement('div');
  modal.className = 'wa-modal-overlay';
  modal.innerHTML = `
    <div class="wa-modal-card">
      <div class="wa-modal-header">
        <h3 class="wa-modal-title">${icons.gallery} <span>Mídias e Arquivos</span></h3>
        <button class="wa-modal-close" id="close-media-modal">${icons.close}</button>
      </div>

      <div class="wa-modal-body">
        <div class="media-tabs">
          <button type="button" class="media-tab-btn ${activeTab === 'photos' ? 'active' : ''}" data-tab="photos">
            Fotos (${photos.length})
          </button>
          <button type="button" class="media-tab-btn ${activeTab === 'audios' ? 'active' : ''}" data-tab="audios">
            Áudios (${audios.length})
          </button>
          <button type="button" class="media-tab-btn ${activeTab === 'files' ? 'active' : ''}" data-tab="files">
            Arquivos (${files.length})
          </button>
        </div>

        <div id="media-tab-content">
          ${activeTab === 'photos' ? `
            ${photos.length === 0 ? '<p style="text-align:center; color:var(--text-tertiary); padding:20px;">Nenhuma foto compartilhada ainda.</p>' : `
              <div class="media-gallery-grid">
                ${photos.map(p => `
                  <div class="media-gallery-item" data-src="${escapeHtml(p.imageUrl)}" title="Ver foto">
                    <img src="${escapeHtml(p.imageUrl)}" alt="foto" loading="lazy" />
                  </div>
                `).join('')}
              </div>
            `}
          ` : activeTab === 'audios' ? `
            ${audios.length === 0 ? '<p style="text-align:center; color:var(--text-tertiary); padding:20px;">Nenhum áudio gravado ainda.</p>' : `
              <div class="starred-list">
                ${audios.map(a => `
                  <div class="starred-card" data-msgid="${a.id}">
                    <div class="starred-card-top">
                      <span class="starred-card-sender">${escapeHtml(a.senderName || 'Amor')}</span>
                      <span>${formatTime(a.createdAt)}</span>
                    </div>
                    <div style="margin-top: 6px;">
                      <audio controls src="${escapeHtml(a.audioUrl)}" style="width: 100%; height: 36px;"></audio>
                    </div>
                  </div>
                `).join('')}
              </div>
            `}
          ` : `
            ${files.length === 0 ? '<p style="text-align:center; color:var(--text-tertiary); padding:20px;">Nenhum arquivo enviado ainda.</p>' : `
              <div class="starred-list">
                ${files.map(f => `
                  <a class="message-file" href="${escapeHtml(f.fileUrl)}" target="_blank" download="${escapeHtml(f.fileName)}">
                    <span>📎</span>
                    <span>${escapeHtml(f.fileName)}<small>${f.fileSize ? `${Math.round(f.fileSize / 1024)} KB` : 'Arquivo'}</small></span>
                  </a>
                `).join('')}
              </div>
            `}
          `}
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#close-media-modal')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelectorAll('.media-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      renderMediaModal(btn.dataset.tab);
    });
  });

  modal.querySelectorAll('.media-gallery-item').forEach(item => {
    item.addEventListener('click', () => {
      openLightbox(item.dataset.src);
    });
  });
}

// ============================================
// WhatsApp: Papel de Parede da Conversa
// ============================================
async function prepareWallpaper(file) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Selecione um arquivo de imagem.');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('A imagem deve ter no máximo 10 MB.');
  }

  const image = new Image();
  image.src = await blobToDataURL(file);
  await image.decode();

  const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Não foi possível preparar o papel de parede.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const compressedImage = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Não foi possível converter a imagem.'));
    }, 'image/jpeg', 0.78);
  });

  return blobToDataURL(compressedImage);
}

function renderWallpaperModal() {
  const existing = $('.wa-modal-overlay');
  if (existing) existing.remove();

  const wallpapers = [
    { id: 'default', label: 'Roxo N&J Padrão', color: '#0f0a1e' },
    { id: 'whatsapp-dark', label: 'WhatsApp Escuro', color: '#0b141a' },
    { id: 'whatsapp-green', label: 'WhatsApp Verde', color: '#0d1b1e' },
    { id: 'romantic-pink', label: 'Rosa Romance', color: '#190a18' },
    { id: 'amoled', label: 'Preto Puro (AMOLED)', color: '#000000' }
  ];

  const modal = document.createElement('div');
  modal.className = 'wa-modal-overlay';
  modal.innerHTML = `
    <div class="wa-modal-card">
      <div class="wa-modal-header">
        <h3 class="wa-modal-title">${icons.wallpaper} <span>Papel de Parede do Chat</span></h3>
        <button class="wa-modal-close" id="close-wallpaper-modal">${icons.close}</button>
      </div>

      <div class="wa-modal-body">
        <p style="font-size: 0.85rem; color: var(--text-secondary);">
          Escolha um tema ou use uma foto da galeria como fundo da conversa:
        </p>
        <button type="button" class="wallpaper-choose-btn" id="choose-wallpaper-image">
          ${icons.gallery}
          <span>Escolher foto da galeria</span>
        </button>
        <input type="file" id="wallpaper-image-input" accept="image/*" hidden />
        <div class="wallpaper-grid">
          ${wallpapers.map(w => `
            <div class="wallpaper-card ${state.wallpaper === w.id ? 'active' : ''}" data-wallpaper="${w.id}">
              <div class="wallpaper-preview-box" style="background-color: ${w.color};">
                <div style="position: absolute; bottom: 8px; left: 8px; font-size: 0.7rem; color: rgba(255,255,255,0.7);">
                  ${w.id === state.wallpaper ? '✓ Ativo' : ''}
                </div>
              </div>
              <span class="wallpaper-label">${escapeHtml(w.label)}</span>
            </div>
          `).join('')}
          ${state.customWallpaper ? `
            <div class="wallpaper-card ${state.wallpaper === 'custom' ? 'active' : ''}" data-wallpaper="custom">
              <div class="wallpaper-preview-box wallpaper-custom-preview"></div>
              <span class="wallpaper-label">Minha foto</span>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#close-wallpaper-modal')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  const customPreview = modal.querySelector('.wallpaper-custom-preview');
  if (customPreview) {
    customPreview.style.backgroundImage = `url("${state.customWallpaper}")`;
  }

  const wallpaperInput = modal.querySelector('#wallpaper-image-input');
  modal.querySelector('#choose-wallpaper-image')?.addEventListener('click', () => wallpaperInput.click());
  wallpaperInput?.addEventListener('change', async () => {
    const [file] = wallpaperInput.files || [];
    wallpaperInput.value = '';
    if (!file) return;

    try {
      const wallpaperData = await prepareWallpaper(file);
      localStorage.setItem('nj-custom-wallpaper', wallpaperData);
      state.customWallpaper = wallpaperData;
      state.wallpaper = 'custom';
      applyWallpaper();
      renderWallpaperModal();
      showToast('Papel de parede atualizado! ✨');
    } catch (error) {
      console.error('Wallpaper update error:', error);
      showToast(error.message || 'Não foi possível atualizar o papel de parede.');
    }
  });

  modal.querySelectorAll('.wallpaper-card[data-wallpaper]').forEach(card => {
    card.addEventListener('click', () => {
      state.wallpaper = card.dataset.wallpaper;
      applyWallpaper();
      renderWallpaperModal();
      showToast('Papel de parede atualizado! ✨');
    });
  });
}

// ============================================
// Modal de Configuração do Firebase
// ============================================
function renderFirebaseModal() {
  const existing = $('.firebase-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'firebase-modal-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 3000;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  `;

  overlay.innerHTML = `
    <div style="background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 20px; max-width: 440px; width: 100%; padding: 24px; box-shadow: var(--shadow-lg);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="font-family: var(--font-display); font-size: 1.2rem; font-weight: 600;">Configurar Firebase</h3>
        <button id="close-fb-modal" style="cursor: pointer; color: var(--text-secondary); font-size: 1.2rem;">✕</button>
      </div>
      <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.4;">
        Para sincronizar as contas e mensagens entre celulares pela internet, cole abaixo os dados do seu projeto do Firebase Console:
      </p>

      <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 18px;">
        <input id="fb-apiKey" style="padding: 10px 14px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; font-size: 0.85rem;" placeholder="apiKey" />
        <input id="fb-authDomain" style="padding: 10px 14px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; font-size: 0.85rem;" placeholder="authDomain" />
        <input id="fb-projectId" style="padding: 10px 14px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; font-size: 0.85rem;" placeholder="projectId" />
        <input id="fb-storageBucket" style="padding: 10px 14px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; font-size: 0.85rem;" placeholder="storageBucket" />
        <input id="fb-appId" style="padding: 10px 14px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; font-size: 0.85rem;" placeholder="appId" />
      </div>

      <div style="display: flex; gap: 10px;">
        <button id="save-fb-config" style="flex: 1; padding: 12px; background: var(--accent-gradient); color: white; border-radius: 10px; font-weight: 600; cursor: pointer;">
          Salvar e Recarregar
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#close-fb-modal').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#save-fb-config').addEventListener('click', () => {
    const config = {
      apiKey: overlay.querySelector('#fb-apiKey').value.trim(),
      authDomain: overlay.querySelector('#fb-authDomain').value.trim(),
      projectId: overlay.querySelector('#fb-projectId').value.trim(),
      storageBucket: overlay.querySelector('#fb-storageBucket').value.trim(),
      appId: overlay.querySelector('#fb-appId').value.trim(),
    };

    if (!config.apiKey || !config.projectId) {
      alert('Preencha ao menos o apiKey e o projectId');
      return;
    }

    localStorage.setItem('nj_firebase_config', JSON.stringify(config));
    overlay.remove();
    window.location.reload();
  });
}

// ============================================
// Settings
// ============================================
function renderSettings() {
  if (!state.showSettings) {
    const overlay = $('.settings-overlay');
    const panel = $('.settings-panel');
    if (overlay) overlay.remove();
    if (panel) panel.remove();
    return;
  }

  const existingOverlay = $('.settings-overlay');
  const existingPanel = $('.settings-panel');
  if (existingOverlay) existingOverlay.remove();
  if (existingPanel) existingPanel.remove();

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';

  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  panel.innerHTML = `
    <div class="settings-header">
      <h2 class="settings-title">Configurações</h2>
      <button class="settings-close">${icons.close}</button>
    </div>

    <div class="settings-section">
      <div class="settings-label">Sua Conta</div>
      <div style="display: flex; align-items: center; gap: 14px; padding: 12px; background: var(--bg-surface); border-radius: 12px; margin-bottom: 12px; cursor: pointer;" id="settings-open-profile">
        <div style="width: 50px; height: 50px; border-radius: 50%; overflow: hidden; background: var(--accent-gradient); display: flex; align-items: center; justify-content: center; font-weight: 700; color: white;">
          ${getUserPhotoURL()
            ? `<img src="${escapeHtml(getUserPhotoURL())}" style="width:100%;height:100%;object-fit:cover;" alt="Foto" />`
            : `<span>${escapeHtml(getUserInitial())}</span>`}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 1rem;">${escapeHtml(state.user?.displayName || 'Você')}</div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${escapeHtml(getUserStatusMessage())}
          </div>
        </div>
        <div style="font-size: 0.8rem; color: var(--accent-primary); font-weight: 600;">Editar</div>
      </div>

      <div class="settings-toggle">
        <span>📧 ${escapeHtml(state.user?.email || '')}</span>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Aparência & Chat</div>
      <div class="settings-toggle" id="theme-setting" style="cursor: pointer;">
        <span>${state.theme === 'dark' ? '🌙' : '☀️'} Modo ${state.theme === 'dark' ? 'escuro' : 'claro'}</span>
        <div class="toggle-switch ${state.theme === 'dark' ? 'active' : ''}"></div>
      </div>
      <div class="settings-toggle" id="settings-open-wallpaper" style="cursor: pointer;">
        <span>🎨 Papel de parede da conversa</span>
        <span style="font-size: 0.8rem; color: var(--accent-primary);">Alterar</span>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Sincronização em Nuvem</div>
      <div class="settings-toggle" id="settings-open-firebase" style="cursor: pointer;">
        <span>☁️ Conexão Firebase</span>
        <span style="font-size: 0.78rem; color: var(--text-tertiary);">Configurar</span>
      </div>
    </div>

    <button class="settings-logout" id="logout-btn">
      Sair da conta
    </button>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(panel);

  overlay.addEventListener('click', () => {
    state.showSettings = false;
    renderSettings();
  });

  panel.querySelector('.settings-close')?.addEventListener('click', () => {
    state.showSettings = false;
    renderSettings();
  });

  panel.querySelector('#settings-open-profile')?.addEventListener('click', () => {
    state.showSettings = false;
    renderSettings();
    renderMyProfile();
  });

  panel.querySelector('#settings-open-wallpaper')?.addEventListener('click', () => {
    state.showSettings = false;
    renderSettings();
    renderWallpaperModal();
  });

  panel.querySelector('#settings-open-firebase')?.addEventListener('click', () => {
    renderFirebaseModal();
  });

  panel.querySelector('#theme-setting')?.addEventListener('click', () => {
    toggleTheme();
  });

  panel.querySelector('#logout-btn')?.addEventListener('click', () => {
    logoutUser();
  });
}

async function logoutUser() {
  try { await updatePresence(false); } catch(error) {
    console.error('Presence shutdown error:', error);
  }
  try { await setTyping(false); } catch(e) {}
  if (state.unsubMessages) { try { state.unsubMessages(); } catch(e) {} }
  if (state.unsubPresence) { try { state.unsubPresence(); } catch(e) {} }
  if (state.unsubTyping) { try { state.unsubTyping(); } catch(e) {} }
  if (state.presenceInterval) clearInterval(state.presenceInterval);

  setActiveSession(null);
  localStorage.removeItem('nj_current_local_user');
  localStorage.removeItem('nj_active_session');
  state.user = null;
  state.showSettings = false;

  if (auth && isFirebaseConfigured()) {
    try { await signOut(auth); } catch (e) {}
  }

  showToast('Você saiu da conta');
  renderSettings();
  renderLogin('login');
}

// ============================================
// Initialization
// ============================================
function init() {
  if (!isFirebaseConfigured() || !auth) {
    const session = getActiveSession();
    if (session) {
      state.user = session;
      renderChat();
    } else {
      renderLogin('login');
    }
    return;
  }

  onAuthStateChanged(auth, (user) => {
    if (user) {
      if (!isCoupleMember(user.uid)) {
        state.user = null;
        setActiveSession(null);
        renderLogin('login');
        showToast('Esta conta não tem autorização para acessar o chat.');
        signOut(auth).catch((error) => {
          console.error('Unauthorized account sign-out error:', error);
        });
        return;
      }

      state.user = {
        uid: user.uid,
        displayName: user.displayName || 'Amor',
        email: user.email,
        photoURL: user.photoURL || null,
        statusMessage: 'Disponível'
      };
      setActiveSession(state.user);
      renderChat();
    } else {
      setActiveSession(null);
      renderLogin('login');
    }
  });
}

init();
