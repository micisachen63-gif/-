// Visual themes. Swapping art = replacing assets\bg\<theme>\<layout>.png (1920x1080).
export const THEMES = {
  song: {
    key: 'song', name: '爽爆', emblem: '爽', emblemSub: '娛樂城',
    bg: ['#ffe2f1', '#f3e7ff', '#dff0ff'], coverBg: ['#ffb3d6', '#d7a6ff', '#9cc0ff'],
    ink: '#55306f', soft: '#8a6aa5', muted: '#a68fbd',
    a1: '#ff6fae', a1l: '#ffc6e0', a2: '#a68bff', a2l: '#ddd2ff', a3: '#5aaeff', a3l: '#cde6ff', gold: '#ffc23d',
    t: ['#ff5aa0', '#c46bff', '#5d9fff'], shadow: '#f39ac7', cardBorder: '#ffd0e6',
    prev: '#73b6ff', cur: '#ff80b6', up: '#ff4f8b', down: '#3b86f0',
    hearts: ['#ff9cc9', '#ffb6d8', '#c9b5ff', '#9fd0ff', '#ffd27a'], stars: ['#ffd75e', '#ffffff', '#ffc1e0', '#cbb8ff'],
    emoji: {cover: ['👑', '💎', '🪙', '🎀', '💖', '🎰'], kpi: ['🤖', '💰'], tiers: ['🤖', '🐱'], machines: ['🎰', '🏆'], rtp: ['🛡️', '📈'], strategy: ['🐱', '📣']},
    ranks: ['#ffc23d', '#b8c4d8', '#f2a272', '#7fb8ff', '#ff9cc6'],
  },
  qz: {
    key: 'qz', name: '茄子', emblem: '茄', emblemSub: '娛樂城',
    bg: ['#efe4ff', '#f6efff', '#e3f6e6'], coverBg: ['#b98ae6', '#8f5cc9', '#5fb578'],
    ink: '#47285f', soft: '#76579a', muted: '#9a84b3',
    a1: '#9a4fd3', a1l: '#dcc3f5', a2: '#5cb874', a2l: '#cdeed4', a3: '#7d8cf2', a3l: '#d6dbff', gold: '#f3bf3f',
    t: ['#b45cf0', '#7f3fc4', '#3f9f63'], shadow: '#c6a3ea', cardBorder: '#e2d0f6',
    prev: '#8fd19e', cur: '#a96be0', up: '#d6458f', down: '#2f8f58',
    hearts: ['#c9a3f2', '#e2c8ff', '#a8e0b4', '#ffd98a', '#d7b8ff'], stars: ['#ffd75e', '#ffffff', '#d9c2ff', '#bfe8c8'],
    emoji: {cover: ['👑', '🍆', '🪙', '🌿', '💜', '🎰'], kpi: ['🍆', '💰'], tiers: ['🍆', '🌿'], machines: ['🎰', '🏆'], rtp: ['🛡️', '📈'], strategy: ['🍆', '📣']},
    ranks: ['#f3bf3f', '#b8c4d8', '#f2a272', '#8fd19e', '#c9a3f2'],
  },
};
export const LAYOUTS = ['cover', 'kpi', 'tiers', 'machines', 'rtp', 'strategy'];
