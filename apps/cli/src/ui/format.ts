/** Cuts `text` to `width` characters with an ellipsis */
export const fit = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
