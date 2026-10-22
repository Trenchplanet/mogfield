export type ToolId = "studio" | "restyle" | "reshoot" | "t2v" | "characters";

/** What each tool does, in one line: the first thing a new visitor reads. */
const TOOLS: { id: ToolId; name: string; line: string; icon: string; tint: string }[] = [
  { id: "studio", name: "Character Swap", line: "Put your character into any video", icon: "M8 8m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 20c0-3 2.2-5 5-5M16 8m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M14 20c0-3 1-5 5-5M11 17h6M15 15l2 2-2 2", tint: "10,132,255" },
  { id: "restyle", name: "Restyle", line: "Same motion, a whole new look", icon: "M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z", tint: "191,90,242" },
  { id: "reshoot", name: "Re-shoot", line: "The same moment, a new camera angle", icon: "M4 8h3l2-2h6l2 2h3v11H4zM12 13m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0", tint: "255,159,10" },
  { id: "t2v", name: "Text to video", line: "Describe a scene, get a clip", icon: "M4 6h16M4 11h10M4 16h7M16 14l5 3-5 3z", tint: "48,209,88" },
  { id: "characters", name: "Character Studio", line: "Turn a photo into a character sheet", icon: "M12 8m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M5 21c0-4 3-6 7-6s7 2 7 6", tint: "255,69,58" },
];

/** The tools, as cards: tap one to open it. The current one is marked. */
export function ToolCards({ active, onPick }: { active: ToolId; onPick: (id: ToolId) => void }) {
  return (
    <nav className="tool-cards" aria-label="Tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tool-card ${t.id === active ? "on" : ""}`}
          style={{ ["--tint" as string]: t.tint }}
          aria-current={t.id === active ? "page" : undefined}
          onClick={() => t.id !== active && onPick(t.id)}
        >
          <i>
            <svg viewBox="0 0 24 24" aria-hidden><path d={t.icon} /></svg>
          </i>
          <b>{t.name}</b>
          <small>{t.line}</small>
          {t.id === active && <em>You're here</em>}
        </button>
      ))}
    </nav>
  );
}
