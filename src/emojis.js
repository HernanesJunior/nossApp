// ============================================
// N&J — Emoji Data
// ============================================

export const emojiCategories = {
  'Amor 💜': ['💜', '💕', '💗', '💖', '💘', '💝', '❤️', '🥰', '😍', '😘', '💋', '🫶', '💑', '👩‍❤️‍👨', '💌', '🌹'],
  'Carinhas 😊': ['😊', '😄', '😂', '🤣', '😅', '😆', '🥹', '🥺', '😢', '😭', '😤', '😡', '🤗', '🤔', '🤭', '😏', '😜', '😝', '🤪', '😴', '🥱', '😮', '😱', '🫣', '🫡', '🤩'],
  'Gestos 👋': ['👋', '🤝', '👍', '👎', '👏', '🙌', '🤞', '✌️', '🤟', '💪', '🫰', '🤙', '👊', '🙏', '☝️', '👆'],
  'Comida 🍕': ['🍕', '🍔', '🍟', '🌮', '🍰', '🧁', '🍩', '🍫', '🍿', '☕', '🍷', '🍺', '🥂', '🍜', '🍣', '🍱'],
  'Natureza 🌸': ['🌸', '🌺', '🌻', '🌷', '🌹', '🍀', '🌈', '⭐', '🌙', '☀️', '🔥', '💫', '✨', '🌊', '🦋', '🐶'],
  'Objetos 🎁': ['🎁', '🎉', '🎊', '🎵', '🎶', '📱', '💻', '🏠', '🚗', '✈️', '🎮', '📸', '🎬', '💡', '🔑', '💍'],
};

export const quickReactions = ['❤️', '😂', '😮', '😢', '👍', '🔥'];

export function getAllEmojis() {
  return Object.values(emojiCategories).flat();
}

export function searchEmojis(query) {
  if (!query) return getAllEmojis();
  // Simple search by category name
  const results = [];
  for (const [category, emojis] of Object.entries(emojiCategories)) {
    if (category.toLowerCase().includes(query.toLowerCase())) {
      results.push(...emojis);
    }
  }
  // If no category match, return all
  return results.length > 0 ? results : getAllEmojis();
}
