export const API_URL =
  import.meta.env.VITE_API_URL || "http://127.0.0.1:5000";

export async function apiRequest(path, options = {}) {
  const {
    token,
    headers = {},
    ...fetchOptions
  } = options;

  const requestHeaders = {
    ...headers,
  };

  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  if (fetchOptions.body instanceof FormData) {
    delete requestHeaders["Content-Type"];
    delete requestHeaders["content-type"];
  } else if (
    fetchOptions.body &&
    typeof fetchOptions.body !== "string"
  ) {
    requestHeaders["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(fetchOptions.body);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...fetchOptions,
    headers: requestHeaders,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.error || data.message || `Request failed: ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  return data;
}
