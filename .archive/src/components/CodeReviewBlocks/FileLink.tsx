import React, { useCallback } from "react";

interface FileLinkProps {
  filePath: string;
  line?: number;
  onOpenFileAtLine?: (filePath: string, line?: number) => void;
  className?: string;
}

const FileLink: React.FC<FileLinkProps> = ({
  filePath,
  line,
  onOpenFileAtLine,
  className = "text-[10px] text-primary-6 hover:underline",
}) => {
  const handleClick = useCallback(() => {
    onOpenFileAtLine?.(filePath, line);
  }, [filePath, line, onOpenFileAtLine]);

  const label = line ? `${filePath}:${line}` : filePath;

  if (!onOpenFileAtLine) {
    return <span className={className}>{label}</span>;
  }

  return (
    <button className={className} onClick={handleClick}>
      {label}
    </button>
  );
};

export default FileLink;
