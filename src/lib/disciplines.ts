/** Disciplines supported by the product (handoff §1). */
export const DISCIPLINES = [
  { value: "civil", label: "Civil" },
  { value: "architectural", label: "Architectural" },
  { value: "structural", label: "Structural" },
  { value: "mechanical", label: "Mechanical" },
  { value: "electrical", label: "Electrical" },
  { value: "electronic", label: "Electronic / PCB" },
  { value: "industrial", label: "Industrial" },
  { value: "computer", label: "Computer / Systems" },
  { value: "marine", label: "Marine" },
  { value: "multidisciplinary", label: "Multidisciplinary" },
] as const

export type Discipline = (typeof DISCIPLINES)[number]["value"]

export const DISCIPLINE_VALUES: string[] = DISCIPLINES.map((d) => d.value)

export function disciplineLabel(value: string): string {
  return DISCIPLINES.find((d) => d.value === value)?.label ?? value
}
