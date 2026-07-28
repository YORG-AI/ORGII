/**
 * MemoryIndexPanel
 *
 * Displays the raw MEMORY.md index text loaded from the workspace memory
 * backend. Shown below the file table when the user clicks the "View Index"
 * toolbar button.
 */
import { BookOpen } from "lucide-react";

export interface MemoryIndexPanelProps {
  indexText: string;
}

const MemoryIndexPanel = ({ indexText }: MemoryIndexPanelProps) => (
  <div className="rounded-lg bg-primary-container px-3 py-2">
    <div className="flex items-center gap-2 pb-2">
      <BookOpen size={14} className="text-text-3" />
      <span className="text-sm font-medium text-text-1">MEMORY.md</span>
    </div>
    <pre className="max-h-[400px] overflow-auto rounded-md bg-bg-3 p-3 text-xs leading-relaxed text-text-2">
      {indexText || "(empty)"}
    </pre>
  </div>
);

export default MemoryIndexPanel;
