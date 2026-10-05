export function page<T>(items: T[], top: number, skip: number) {
  return {
    items: items.slice(skip, skip + top),
    ...(skip + top < items.length ? { nextSkip: skip + top } : {}),
  };
}
export function boundedText(text: string, limit = 4000) {
  return { text: text.slice(0, limit), truncated: text.length > limit };
}
