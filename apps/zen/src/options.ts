import { appAddressOf } from "@omp-app/embed";
import { forgetKey, saveAppAddress, storedAppAddress } from "./address";

/**
 * The extension's settings: omp app's address, and forgetting this browser's key (it then pairs again). A new address
 * forgets the key too: it was paired with the old one.
 */
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
  void saveAppAddress(checked.address).then((forgotten) => {
    status.className = "";
    status.textContent = forgotten
      ? "Saved. This browser's key was for another address, so the next panel pairs again; remove the old one in omp app's Settings → App → Devices too."
      : "Saved. Panels opened from now on use it.";
  });
});

forget.addEventListener("click", () => {
  void forgetKey().then(() => {
    status.className = "";
    status.textContent =
      "Forgotten. The next panel pairs again; remove this browser in omp app's Settings → App → Devices too.";
  });
});
