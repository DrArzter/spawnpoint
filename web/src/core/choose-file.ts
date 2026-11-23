/** Opens the browser's file chooser from a press and hands the chosen file on. Nothing is mounted: the input lives only for the choice. */
export function chooseFile(accept: string, onFile: (file: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
  }, { once: true });
  input.click();
}
