@tailwind base;
@tailwind components;
@tailwind utilities;

@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;500;600&display=swap');

html, body { background: #0a0908; color: white; font-family: 'Inter', sans-serif; }

@keyframes pulse-live { 0%,100% { opacity:1 } 50% { opacity:.35 } }
@keyframes slide-up { from { transform: translateY(12px); opacity:0 } to { transform: translateY(0); opacity:1 } }
.live-dot { animation: pulse-live 1.4s ease-in-out infinite }
.card-enter { animation: slide-up .5s ease-out both }
.display { font-family: 'Fraunces', serif; font-optical-sizing: auto; letter-spacing: -0.02em }
.mono { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums }
