import { useCallback, useRef, useState } from "react";
import { saveFile } from "./api.js";

// Downloads a server-built PDF: one request at a time, a readable error, and
// no error for a 401 (the api wrapper already signs out).
export default function usePdfDownload(api) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // State updates are async, so a fast double click would pass a state-only check.
  const busyRef = useRef(false);

  const download = useCallback(
    async (url, fallbackName) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError("");
      try {
        const { blob, filename, warnings } = await api(url, { as: "blob" });
        saveFile(blob, filename || fallbackName);
        if (warnings) {
          setError(
            `PDF сформирован с замечаниями (${warnings}): часть данных заменена — например, фото заглушкой или итог пересчитан. Проверьте документ.`
          );
        }
      } catch (err) {
        if (err.status === 401) return;
        // The generic API 404: the running server predates this PDF route.
        const outdated = err.status === 404 && err.message === "Не найдено";
        setError(outdated ? "Сервер ещё не обновлён. Перезапустите сайт и попробуйте снова." : err.message);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [api]
  );

  return { busy, error, download };
}
