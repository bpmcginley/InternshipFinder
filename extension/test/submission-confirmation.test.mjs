import test from "node:test";
import assert from "node:assert/strict";
import { checkSubmitted } from "../background/agent.js";

function withFrames(t, texts) {
  return t.mock.method(globalThis.chrome.scripting, "executeScript", async ({ func, args }) =>
    texts.map((innerText) => {
      globalThis.document = { body: { innerText } };
      return { result: func(...args) };
    }),
  );
}

globalThis.chrome = { scripting: { async executeScript() { return []; } } };

test("welcome copy and application instructions do not confirm submission", async (t) => {
  withFrames(t, [
    "Thank you for your interest in applying. Complete the form below.",
    "Thanks for applying. Complete your application now.",
    "Once your application is submitted, you will get an email.",
    "Your application was not submitted. Please review the form.",
    "You’ve applied filters.",
    "Thank you for submitting your application details. Complete the next step.",
    "Merci de votre intérêt pour ce poste. Complétez la candidature.",
    "Su solicitud no fue enviada.",
    "Resume upload\nSuccessfully submitted\nComplete your application",
  ]);
  assert.equal(await checkSubmitted(7), false);
});

test("unambiguous completion and receipt messages still confirm submission", async (t) => {
  for (const confirmation of [
    "Application submitted",
    "Your application was successfully submitted.",
    "Thank you for submitting your application!",
    "We’ve received your application and will review it.",
    "You have successfully applied.",
    "Votre candidature a bien e\u0301te\u0301 envoye\u0301e.",
    "Hemos recibido tu solicitud.",
    "Su solicitud se ha enviado correctamente.",
    "Ihre Bewerbung wurde erfolgreich eingereicht.",
    "La tua candidatura è stata inviata con successo.",
    "Sua candidatura foi enviada com sucesso.",
    "ご応募を受け付けました。",
  ]) {
    const mock = withFrames(t, ["Careers", `Internship application\n${confirmation}\nBack to open roles`]);
    assert.equal(await checkSubmitted(7), true, confirmation);
    mock.mock.restore();
  }
});
