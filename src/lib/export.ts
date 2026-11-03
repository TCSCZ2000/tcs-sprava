// Export do Excelu (SheetJS se načte až při prvním použití) a tisk do PDF přes prohlížeč
export type Cell = string | number | null | undefined
export async function exportXlsx(filename: string, sheets: { name: string; rows: Cell[][]; widths?: number[] }[]) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows.map(r => r.map(c => c ?? '')))
    if (s.widths) ws['!cols'] = s.widths.map(w => ({ wch: w }))
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31))
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : filename + '.xlsx')
}
export function printPdf() { window.print() }
