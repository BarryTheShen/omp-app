import { appAddressOf, STORED, storedAppAddress } from "./address";

/** The extension's settings: omp app's address, and forgetting this browser's key (it then pairs again). */
const form = document.getElementById("address") as HTMLFormElement;
const field = document.getElementById("app") as HTMLInputElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const forget = document.getElementById("forget") as HTMLButtonElement;

void storedAppAddress().then((address) => {
  if (address !== null) field.value = address;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const checked = appAddressOf(field.value);
  if ("problem" in checked) {
    status.className = "problem";
    status.textContent = checked.problem;
    return;
  }
  field.value = checked.address;
  void browser.storage.local.set({ [STORED.app]: checked.address }).then(() => {
    status.className = "";
    status.textContent = "Saved. Panels opened from now on use it.";
  });
});

forget.addEventListener("click", () => {
  void browser.storage.local.remove(STORED.key).then(() => {
    status.className = "";
    status.textContent =
      "Forgotten. The next panel pairs again; remove this browser in omp app's Settings → App → Devices too.";
  });
});
