const sample = Object.freeze({
  first_name: "Sample",
  last_name: "Student",
  email: "sample.student@example.invalid",
  phone: "2025550100",
});
const form = document.querySelector("form");
const fill = document.querySelector("#fill");
const complete = document.querySelector("#complete");
const result = document.querySelector("#result");
const fields = [...form.querySelectorAll("input")];
let filling = false;

form.addEventListener("submit", (event) => event.preventDefault());

fill.addEventListener("click", async () => {
  if (filling) return;
  filling = true;
  complete.disabled = true;
  for (const field of fields) {
    field.value = "";
    field.readOnly = false;
  }
  let filled = false;
  try {
    await window.ISDom.fastFill(sample, null, { gen: 1 });
    filled = fields.every((field) => field.value === sample[field.name]);
  } catch {
    // Offer a local retry if the bundled fill cannot finish.
  } finally {
    for (const field of fields) {
      field.readOnly = true;
      if (!filled) field.value = "";
    }
    filling = false;
  }
  complete.disabled = !filled;
  complete.classList.toggle("primary", filled);
  fill.classList.toggle("primary", !filled);
  result.textContent = filled
    ? "Sample details filled. Review them, then complete the practice."
    : "Couldn’t fill the sample details. Try again.";
  if (fields.includes(document.activeElement)) fill.focus({ preventScroll: true });
});

complete.addEventListener("click", () => {
  if (!complete.disabled) result.textContent = "Practice complete.";
});
