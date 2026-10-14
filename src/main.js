// ============================================
// N&J — Main Application
// ============================================

import './style.css';
import { auth, db, storage, isFirebaseConfigured } from './firebase.js';
import {
  registerAccount,
  loginAccount,
  loginWithGoogle,
  getActiveSession,
  setActiveSession,
  getRegisteredUsers
} from './auth.js';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  doc,
  updateDoc
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
  user: null, // { uid, displayName, email }
  partner: null, // { uid, displayName, online, lastSeen }
  messages: [],
  theme: localStorage.getItem('nj-theme') || 'dark',
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  showEmojiPicker: false,
  showReactionPicker: null, // messageId
  showSettings: false,
  imageFiles: [],
  typingTimeout: null,
  unsubMessages: null,
  unsubPresence: null,
  unsubTyping: null,
};

// ============================================
// Theme
// ============================================
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('nj-theme', state.theme);
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  renderSettings();
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
    if (type === 'NEW_MESSAGE' || type === 'UPDATE_MESSAGE') {
      if (state.isLocalMode) {
        state.messages = getLocalMessages();
        renderMessages();
      }
    } else if (type === 'TYPING') {
      if (data.email !== state.user?.email) {
        updateHeaderStatus(data.isTyping);
      }
    } else if (type === 'PRESENCE') {
      if (data.email !== state.user?.email) {
        state.partner = {
          displayName: data.displayName,
          email: data.email,
          online: data.online,
          lastSeen: data.lastSeen
        };
        updateHeaderStatus(false);
      }
    }
  };
}

// ============================================
// Auth & Login / Register Screen
// ============================================
function renderLogin(mode = 'login') {
  const app = $('#app');
  const isRegister = mode === 'register';

  app.innerHTML = `
    <div class="login-screen">
      <div class="login-logo">${icons.heart}</div>
      <h1 class="login-title">N&J</h1>
      <p class="login-subtitle">O chat privado de vocês dois 💜</p>

      <!-- Botão Google -->
      <button type="button" id="google-login-btn" style="width: 100%; max-width: 360px; padding: 12px 18px; background: #ffffff; color: #3c4043; border-radius: 12px; font-weight: 600; font-size: 0.95rem; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); transition: 0.2s; z-index: 2;">
        <span style="width: 20px; height: 20px; display: flex; align-items: center;">${icons.google}</span>
        <span>Continuar com o Google</span>
      </button>

      <div style="display: flex; align-items: center; gap: 12px; width: 100%; max-width: 360px; margin-bottom: 16px; color: var(--text-tertiary); font-size: 0.8rem; z-index: 2;">
        <div style="flex: 1; height: 1px; background: var(--border-subtle);"></div>
        <span>ou com e-mail</span>
        <div style="flex: 1; height: 1px; background: var(--border-subtle);"></div>
      </div>

      <!-- Abas de Alternância -->
      <div style="display: flex; gap: 8px; margin-bottom: 20px; width: 100%; max-width: 360px; background: var(--bg-surface); padding: 4px; border-radius: 12px; border: 1px solid var(--border-subtle); z-index: 2;">
        <button type="button" id="tab-login" style="flex: 1; padding: 10px; border-radius: 8px; font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: 0.2s; background: ${!isRegister ? 'var(--accent-gradient)' : 'transparent'}; color: ${!isRegister ? '#fff' : 'var(--text-secondary)'};">
          Entrar
        </button>
        <button type="button" id="tab-register" style="flex: 1; padding: 10px; border-radius: 8px; font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: 0.2s; background: ${isRegister ? 'var(--accent-gradient)' : 'transparent'}; color: ${isRegister ? '#fff' : 'var(--text-secondary)'};">
          Criar Conta
        </button>
      </div>

      <!-- Formulário -->
      <div class="login-form" id="auth-form-container">
        ${isRegister ? `
          <div class="login-input-group">
            <input type="text" id="auth-name" placeholder="Seu nome (ex: Junior ou Naftaly)" autocomplete="name" />
          </div>
        ` : ''}
        <div class="login-input-group">
          <input type="email" id="auth-email" placeholder="Seu e-mail" autocomplete="email" />
        </div>
        <div class="login-input-group">
          <input type="password" id="auth-password" placeholder="Sua senha (mínimo 6 dígitos)" autocomplete="${isRegister ? 'new-password' : 'current-password'}" />
        </div>
        ${isRegister ? `
          <div class="login-input-group">
            <input type="password" id="auth-password-confirm" placeholder="Confirme sua senha" autocomplete="new-password" />
          </div>
        ` : ''}

        <p class="login-error" id="auth-error"></p>

        <button type="button" class="login-btn" id="auth-submit-btn">
          ${isRegister ? 'Criar minha conta' : 'Entrar no Chat'} 💜
        </button>
      </div>

      <div style="margin-top: 18px; z-index: 2; text-align: center;">
        <button id="open-firebase-config" style="background: none; border: none; font-size: 0.78rem; color: var(--text-tertiary); cursor: pointer; text-decoration: underline;">
          ⚙️ ${isFirebaseConfigured() ? 'Firebase Conectado na Nuvem' : 'Configurar Sincronização em Nuvem (Firebase)'}
        </button>
      </div>
    </div>
  `;

  // Tabs events
  $('#tab-login').addEventListener('click', () => renderLogin('login'));
  $('#tab-register').addEventListener('click', () => renderLogin('register'));

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
    const name = isRegister ? $('#auth-name')?.value.trim() : '';

    if (!email || !password) {
      errorEl.textContent = 'Preencha todos os campos.';
      return;
    }

    if (password.length < 6) {
      errorEl.textContent = 'A senha deve ter pelo menos 6 caracteres.';
      return;
    }

    if (isRegister) {
      if (!name) {
        errorEl.textContent = 'Digite seu nome.';
        return;
      }
      const confirm = $('#auth-password-confirm')?.value;
      if (password !== confirm) {
        errorEl.textContent = 'As senhas não coincidem.';
        return;
      }
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div class="spinner" style="margin: 0 auto;"></div>';

    try {
      if (isRegister) {
        const user = await registerAccount(name, email, password);
        state.user = user;
        showToast(`Conta criada com sucesso, bem-vindo(a) ${user.displayName}! 💜`);
      } else {
        const user = await loginAccount(email, password);
        state.user = user;
        showToast(`Bem-vindo(a) de volta, ${user.displayName}! 💜`);
      }
      renderChat();
    } catch (err) {
      console.error('Auth error:', err);
      errorEl.textContent = err.message || 'Erro ao processar. Verifique os dados.';
      submitBtn.disabled = false;
      submitBtn.innerHTML = `${isRegister ? 'Criar minha conta' : 'Entrar no Chat'} 💜`;
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

  if (localChannel) {
    localChannel.postMessage({
      type: 'PRESENCE',
      data: {
        email: state.user.email,
        displayName: state.user.displayName,
        online,
        lastSeen: new Date().toISOString()
      }
    });
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
}

function listenPartnerPresence() {
  updatePresence(true);
}

function updateHeaderStatus(isTyping = false) {
  const statusEl = $('.header-status');
  const dotEl = $('.online-dot');
  if (!statusEl) return;

  if (isTyping) {
    statusEl.textContent = 'digitando...';
    statusEl.classList.add('typing');
  } else if (state.partner?.online) {
    statusEl.textContent = 'online';
    statusEl.classList.remove('typing');
    if (dotEl) dotEl.classList.remove('offline');
  } else {
    statusEl.textContent = 'online';
    statusEl.classList.remove('typing');
    if (dotEl) dotEl.classList.remove('offline');
  }
}

// ============================================
// Messages
// ============================================
function listenMessages() {
  if (state.isLocalMode) {
    state.messages = getLocalMessages();
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

    snapshot.docChanges().forEach(change => {
      if (change.type === 'added') {
        const msg = change.doc.data();
        if (msg.senderEmail !== state.user?.email && !msg.read) {
          updateDoc(doc(db, 'messages', change.doc.id), { read: true }).catch(() => {});
        }
      }
    });

    state.messages = newMessages;
    renderMessages();
  });
}

async function sendMessage(text, imageUrl = null, audioUrl = null) {
  if (!text && !imageUrl && !audioUrl) return;

  const newMessage = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    text: String(text || ''),
    imageUrl: imageUrl ? String(imageUrl) : null,
    audioUrl: audioUrl ? String(audioUrl) : null,
    senderEmail: String(state.user?.email || 'anonimo@nj.local'),
    senderName: String(state.user?.displayName || 'Amor'),
    createdAt: new Date().toISOString(),
    read: false,
    reactions: {}
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
    return;
  }

  try {
    await addDoc(collection(db, 'messages'), {
      text: newMessage.text,
      imageUrl: newMessage.imageUrl,
      audioUrl: newMessage.audioUrl,
      senderEmail: newMessage.senderEmail,
      senderName: newMessage.senderName,
      read: false,
      reactions: {},
      createdAt: serverTimestamp()
    });
    setTyping(false);
  } catch (e) {
    console.error('Send error:', e);
    showToast(`Erro ao enviar: ${e.code || e.message}`);
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

// ============================================
// File Upload & Audio Recording
// ============================================
async function uploadImage(file) {
  if (state.isLocalMode || !storage) {
    return await blobToDataURL(file);
  }
  const fileName = `images/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, fileName);
  const snapshot = await uploadBytes(storageRef, file);
  return getDownloadURL(snapshot.ref);
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

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.mediaRecorder = new MediaRecorder(stream);
    state.audioChunks = [];

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.audioChunks.push(e.data);
    };

    state.mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(state.audioChunks, { type: 'audio/webm' });
      stream.getTracks().forEach(t => t.stop());

      showToast('Enviando áudio...');
      try {
        const url = await uploadAudio(audioBlob);
        await sendMessage('', null, url);
        showToast('Áudio enviado! 🎤');
      } catch (e) {
        console.error('Audio upload error:', e);
        showToast('Erro ao enviar áudio');
      }
    };

    state.mediaRecorder.start();
    state.isRecording = true;
    updateSendButton();
    showToast('Gravando áudio... 🎙️');
  } catch (e) {
    console.error('Recording error:', e);
    showToast('Não foi possível acessar o microfone');
  }
}

function stopRecording() {
  if (state.mediaRecorder && state.isRecording) {
    state.mediaRecorder.stop();
    state.isRecording = false;
    updateSendButton();
  }
}

function updateSendButton() {
  const sendBtn = $('.send-btn');
  if (!sendBtn) return;

  if (state.isRecording) {
    sendBtn.classList.add('recording');
    sendBtn.innerHTML = icons.stop;
  } else {
    sendBtn.classList.remove('recording');
    sendBtn.innerHTML = icons.send;
  }
}

// ============================================
// Render: Chat
// ============================================
function renderChat() {
  const app = $('#app');
  app.innerHTML = `
    <div class="chat-app">
      <!-- Header -->
      <div class="chat-header">
        <div class="header-avatar">
          <span>${getPartnerInitial()}</span>
          <div class="online-dot"></div>
        </div>
        <div class="header-info">
          <div class="header-name">${getPartnerName()}</div>
          <div class="header-status">online</div>
        </div>
        <div class="header-actions">
          <button class="header-btn" id="theme-toggle-btn" title="Alternar tema">
            ${state.theme === 'dark' ? icons.sun : icons.moon}
          </button>
          <button class="header-btn" id="settings-btn" title="Configurações">
            ${icons.settings}
          </button>
          <button class="header-btn" id="header-logout-btn" title="Sair da conta" style="color: #f87171;">
            ${icons.logout}
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div class="chat-messages" id="messages-container">
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
        <div class="input-container">
          <div class="input-actions-left">
            <button class="input-btn" id="emoji-btn" title="Emoji">${icons.emoji}</button>
            <button class="input-btn" id="image-btn" title="Enviar foto">${icons.image}</button>
            <button class="input-btn" id="mic-btn" title="Gravar áudio">${icons.mic}</button>
          </div>
          <textarea class="message-input" id="message-input" placeholder="Digita aqui, amor... 💜" rows="1"></textarea>
          <button class="send-btn" id="send-btn">${icons.send}</button>
        </div>
        <input type="file" id="image-file-input" accept="image/*" multiple style="display:none;" />
      </div>
    </div>
  `;

  setupChatEvents();
  listenMessages();
  listenPartnerPresence();

  document.addEventListener('visibilitychange', () => {
    updatePresence(!document.hidden);
  });

  window.addEventListener('beforeunload', () => {
    updatePresence(false);
    setTyping(false);
  });
}

function setupChatEvents() {
  const input = $('#message-input');
  const sendBtn = $('#send-btn');
  const emojiBtn = $('#emoji-btn');
  const imageBtn = $('#image-btn');
  const micBtn = $('#mic-btn');
  const fileInput = $('#image-file-input');
  const settingsBtn = $('#settings-btn');
  const themeBtn = $('#theme-toggle-btn');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';

    setTyping(true);
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => setTyping(false), 2000);
  });

  sendBtn.addEventListener('click', handleSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  emojiBtn.addEventListener('click', () => {
    state.showEmojiPicker = !state.showEmojiPicker;
    if (state.showEmojiPicker) {
      renderEmojiPicker();
    } else {
      const picker = $('.emoji-picker-modal');
      if (picker) picker.remove();
    }
  });

  imageBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleImageSelect);

  micBtn.addEventListener('click', () => {
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  settingsBtn.addEventListener('click', () => {
    state.showSettings = true;
    renderSettings();
  });

  const headerLogoutBtn = $('#header-logout-btn');
  if (headerLogoutBtn) {
    headerLogoutBtn.addEventListener('click', async () => {
      try { await updatePresence(false); } catch(e) {}
      try { await setTyping(false); } catch(e) {}
      if (state.unsubMessages) { try { state.unsubMessages(); } catch(e) {} }
      if (state.unsubPresence) { try { state.unsubPresence(); } catch(e) {} }
      if (state.unsubTyping) { try { state.unsubTyping(); } catch(e) {} }

      setActiveSession(null);
      localStorage.removeItem('nj_current_local_user');
      localStorage.removeItem('nj_active_session');
      state.user = null;
      state.showSettings = false;

      if (auth && isFirebaseConfigured()) {
        try { await signOut(auth); } catch (e) {}
      }

      showToast('Você saiu da conta');
      renderLogin('login');
    });
  }

  themeBtn.addEventListener('click', () => {
    toggleTheme();
    themeBtn.innerHTML = state.theme === 'dark' ? icons.sun : icons.moon;
  });

  document.addEventListener('click', (e) => {
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
}

async function handleSend() {
  const input = $('#message-input');
  const text = input.value.trim();

  if (state.isRecording) {
    stopRecording();
    return;
  }

  if (state.imageFiles.length > 0) {
    showToast('Enviando fotos...');
    for (const file of state.imageFiles) {
      try {
        const url = await uploadImage(file);
        await sendMessage(text && state.imageFiles.indexOf(file) === 0 ? text : '', url);
      } catch (e) {
        console.error('Image upload error:', e);
        showToast('Erro ao enviar foto');
      }
    }
    state.imageFiles = [];
    renderImagePreview();
    if (text) {
      input.value = '';
      input.style.height = 'auto';
    }
    return;
  }

  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  await sendMessage(text);
}

function handleImageSelect(e) {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  state.imageFiles = [...state.imageFiles, ...files];
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
      <img src="${URL.createObjectURL(file)}" alt="preview" />
      <div class="image-preview-remove" data-index="${i}">✕</div>
    </div>
  `).join('');

  bar.querySelectorAll('.image-preview-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      state.imageFiles.splice(idx, 1);
      renderImagePreview();
    });
  });
}

// ============================================
// Render: Messages
// ============================================
function renderMessages() {
  const container = $('#messages-container');
  if (!container) return;

  if (state.messages.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-heart">💜</div>
        <h3>Comecem a conversar!</h3>
        <p>Mande a primeira mensagem para o seu amor 💌</p>
      </div>
    `;
    return;
  }

  let html = '';
  let lastDate = '';

  state.messages.forEach((msg) => {
    const msgDate = formatDate(msg.createdAt);
    if (msgDate && msgDate !== lastDate) {
      lastDate = msgDate;
      html += `<div class="date-divider"><span>${msgDate}</span></div>`;
    }

    const isSent = msg.senderEmail === state.user.email;
    const direction = isSent ? 'sent' : 'received';

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
      statusIcon = msg.read ? `<span class="message-check read">✓✓</span>` : `<span class="message-check">✓</span>`;
    }

    let contentHtml = '';
    if (msg.imageUrl) {
      contentHtml += `<img class="message-image" src="${msg.imageUrl}" alt="foto" data-src="${msg.imageUrl}" />`;
    }
    if (msg.audioUrl) {
      contentHtml += `
        <div class="message-audio">
          <span>🎤</span>
          <audio controls preload="none">
            <source src="${msg.audioUrl}" type="audio/webm" />
          </audio>
        </div>
      `;
    }
    if (msg.text) {
      contentHtml += `<span class="message-text">${escapeHtml(msg.text)}</span>`;
    }

    html += `
      <div class="message-row ${direction}" data-msgid="${msg.id}">
        <div class="message-bubble">
          <button class="emoji-react-btn" data-msgid="${msg.id}">😊</button>
          ${contentHtml}
          ${reactionsHtml}
        </div>
        <div class="message-meta">
          <span>${formatTime(msg.createdAt)}</span>
          ${statusIcon}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });

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

  container.querySelectorAll('.message-image').forEach(img => {
    img.addEventListener('click', () => {
      openLightbox(img.dataset.src);
    });
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
      <div class="settings-toggle">
        <span>👤 ${state.user?.displayName || 'Usuário'}</span>
      </div>
      <div class="settings-toggle">
        <span>📧 ${state.user?.email || ''}</span>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Aparência</div>
      <div class="settings-toggle" id="theme-setting">
        <span>${state.theme === 'dark' ? '🌙' : '☀️'} Modo ${state.theme === 'dark' ? 'escuro' : 'claro'}</span>
        <div class="toggle-switch ${state.theme === 'dark' ? 'active' : ''}"></div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Sobre</div>
      <div class="settings-toggle">
        <span>💜 N&J v1.0</span>
      </div>
      <div class="settings-toggle">
        <span>Feito com amor ❤️</span>
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

  panel.querySelector('.settings-close').addEventListener('click', () => {
    state.showSettings = false;
    renderSettings();
  });

  panel.querySelector('#theme-setting').addEventListener('click', () => {
    toggleTheme();
    const themeBtn = $('#theme-toggle-btn');
    if (themeBtn) themeBtn.innerHTML = state.theme === 'dark' ? icons.sun : icons.moon;
  });

  panel.querySelector('#logout-btn').addEventListener('click', async () => {
    try { await updatePresence(false); } catch(e) {}
    try { await setTyping(false); } catch(e) {}
    if (state.unsubMessages) { try { state.unsubMessages(); } catch(e) {} }
    if (state.unsubPresence) { try { state.unsubPresence(); } catch(e) {} }
    if (state.unsubTyping) { try { state.unsubTyping(); } catch(e) {} }

    setActiveSession(null);
    localStorage.removeItem('nj_current_local_user');
    localStorage.removeItem('nj_active_session');
    state.user = null;
    state.showSettings = false;

    if (auth && isFirebaseConfigured()) {
      try { await signOut(auth); } catch(e) {}
    }

    renderSettings();
    renderLogin('login');
  });
}

// ============================================
// Initialization
// ============================================
function init() {
  const session = getActiveSession();
  if (session) {
    state.user = session;
    renderChat();
    return;
  }

  if (isFirebaseConfigured() && auth) {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        state.user = {
          uid: user.uid,
          displayName: user.displayName || 'Amor',
          email: user.email
        };
        setActiveSession(state.user);
        renderChat();
      } else {
        renderLogin('login');
      }
    });
  } else {
    renderLogin('login');
  }
}

init();
