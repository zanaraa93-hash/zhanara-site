const TOKEN_KEY = "zhanara-admin-token";

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(value) {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function filenameFrom(response) {
  const header = response.headers.get("Content-Disposition") || "";
  const match = header.match(/filename\*=UTF-8''([^;]+)/i) || header.match(/filename="?([^";]+)"?/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// `as: "blob"` returns { blob, filename } for file downloads; errors still come back as JSON.
export async function request(url, { as, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch {
    throw new ApiError("Нет связи с сервером. Проверьте, что сайт запущен, и попробуйте ещё раз.", 0);
  }
  if (as === "blob" && response.ok) {
    try {
      return {
        blob: await response.blob(),
        filename: filenameFrom(response),
        warnings: Number(response.headers.get("X-PDF-Warnings")) || 0,
      };
    } catch {
      throw new ApiError("Файл загрузился не полностью. Попробуйте ещё раз.", 0);
    }
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new ApiError(data.error || "Нужна авторизация", 401);
  if (!response.ok) throw new ApiError(data.error || "Ошибка запроса", response.status);
  return data;
}

export function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking right away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

export function jsonBody(method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
