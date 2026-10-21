export function splitNames(value) {
  return [
    ...new Set(
      String(value ?? "")
        .split(/[、,，;；]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
