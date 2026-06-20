import { FileNode } from './types'

/** Returns all file nodes (type === 'file') in tree order */
export function flattenFiles(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = []
  function walk(items: FileNode[]) {
    for (const node of items) {
      if (node.type === 'file') {
        result.push(node)
      } else if (node.children) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return result
}
