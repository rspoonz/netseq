// Caret helpers that measure the DOM. (The pure caret arithmetic lives in intents.ts.)

type CaretDocument = Document & {
  caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
};

/** The rendered text before a click inside a block, or null if it can't be told. */
export function textBeforePoint(container: HTMLElement, x: number, y: number): string | null {
  const doc = container.ownerDocument as CaretDocument;
  let node: Node | undefined;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) [node, offset] = [position.offsetNode, position.offset];
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) [node, offset] = [range.startContainer, range.startOffset];
  }
  if (!node || !container.contains(node)) return null;
  const range = doc.createRange();
  range.setStart(container, 0);
  range.setEnd(node, offset);
  return range.toString();
}

/**
 * Whether the caret is on the first and/or last visual line of a textarea, counting wrapped
 * lines.
 */
export function caretLine(textarea: HTMLTextAreaElement): { first: boolean; last: boolean } {
  return withMirror(textarea, (markerAt) => {
    const caret = markerAt(textarea.selectionStart).offsetTop;
    return { first: caret === markerAt(0).offsetTop, last: caret === markerAt(textarea.value.length).offsetTop };
  });
}

/** The caret's position inside a textarea, in pixels from its top-left corner. */
export function caretCoordinates(textarea: HTMLTextAreaElement): { top: number; left: number; height: number } {
  return withMirror(textarea, (markerAt) => {
    const marker = markerAt(textarea.selectionStart);
    return { top: marker.offsetTop, left: marker.offsetLeft, height: marker.offsetHeight };
  });
}

const COPIED_STYLES = [
  "boxSizing",
  "width",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
] as const;

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

// Measures text positions with a hidden copy of the textarea's text and styles. `markerAt(i)`
// lays out the text up to index i followed by a marker element, and returns the marker.
function withMirror<T>(textarea: HTMLTextAreaElement, measure: (markerAt: (index: number) => HTMLElement) => T): T {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const name of COPIED_STYLES) mirror.style[name] = style[name];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", height: "auto" });
  document.body.appendChild(mirror);
  const markerAt = (index: number) => {
    mirror.textContent = textarea.value.slice(0, index);
    const marker = mirror.appendChild(document.createElement("span"));
    marker.textContent = ZERO_WIDTH_SPACE;
    return marker;
  };
  try {
    return measure(markerAt);
  } finally {
    mirror.remove();
  }
}
