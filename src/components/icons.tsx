/**
 * 共用图标。收在这里的理由是复用而不是归类：折叠箭头在会话列表、时间树、日志表三处都要，
 * 刷新转圈在侧栏与遮罩两处都要 —— 各写一份 SVG 意味着改线宽要改三遍、改一处忘两处。
 *
 * 尺寸由调用方给，颜色一律 `currentColor`（跟随所在文字的颜色变量，明暗主题自动生效）。
 */

interface IconProps {
  /** 边长像素，默认 12（折叠箭头的行内尺寸） */
  size?: number
}

export function Chevron({ open, size = 12 }: IconProps & { open: boolean }): JSX.Element {
  return (
    <svg
      className={`chevron${open ? ' chevron-open' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

/** 文件夹图标（「在文件管理器中打开」这类动作）。 */
export function FolderIcon({ size = 12 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

/** 刷新图标；`spinning` 时套 `.spin` 动画（扫描中/载入中的统一表达） */
export function RefreshIcon({ spinning, size = 13 }: IconProps & { spinning?: boolean }): JSX.Element {
  return (
    <svg
      className={spinning ? 'spin' : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

export function SearchIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  )
}

/** 交给 claude 分析的图标（四角星）：与「刷新/导出」这类机械动作区分开，一眼看出是 AI 能力 */
export function AnalyzeIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  )
}
