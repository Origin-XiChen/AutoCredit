import type { ReactNode } from 'react'

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'rule' }
  | { type: 'paragraph'; text: string }

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
    list = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }

    if (/^([-*_])\1{2,}$/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'rule' })
      continue
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      flushParagraph()
      const isOrdered = Boolean(ordered)
      if (!list || list.ordered !== isOrdered) {
        flushList()
        list = { ordered: isOrdered, items: [] }
      }
      list.items.push((bullet ?? ordered)?.[1] ?? '')
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'quote', text: quote[1] })
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  return blocks
}

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

function renderInline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let index = 0
  let match: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((match = TOKEN.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(<strong key={`${prefix}-${index++}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(<code key={`${prefix}-${index++}`}>{token.slice(1, -1)}</code>)
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link) {
        nodes.push(
          <button
            key={`${prefix}-${index++}`}
            type="button"
            className="md-link"
            onClick={() => void window.autoCredit.openExternal(link[2])}
          >
            {link[1]}
          </button>,
        )
      }
    }
    lastIndex = TOKEN.lastIndex
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

/** 轻量 Markdown 渲染，支持标题、列表、引用、分隔线、粗体、行内代码和链接。 */
export default function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source)
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const level = Math.min(block.level, 4)
          const content = renderInline(block.text, `h${index}`)
          if (level === 1) return <h3 key={index}>{content}</h3>
          if (level === 2) return <h4 key={index}>{content}</h4>
          if (level === 3) return <h5 key={index}>{content}</h5>
          return <h6 key={index}>{content}</h6>
        }
        if (block.type === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `l${index}-${itemIndex}`)}</li>
          ))
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
        }
        if (block.type === 'quote') {
          return <blockquote key={index}>{renderInline(block.text, `q${index}`)}</blockquote>
        }
        if (block.type === 'rule') {
          return <hr key={index} />
        }
        return <p key={index}>{renderInline(block.text, `p${index}`)}</p>
      })}
    </div>
  )
}
