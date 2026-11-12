// Native renderer for confirmation, Stripe returns and credit offers.
export function mountLanding(root, state, { rules, call, request, ui }) {
  var { safeCheckoutUrl, serverMessage, readCredit, money } = rules;

  var el = ui.el, say = ui.say, contact = ui.contact, again = ui.again, failed = ui.failed;
  function choicePending() {
    say("Your choice is being checked", "The result of your earlier choice is still being confirmed. Please don't choose again or try the other option.",
      "Reopen the original unused-days offer email link later to check the status.", contact("Questions? Email "));
  }
  function choiceUnknown() {
    say("Check your offer status", "We couldn't confirm the result of your choice. It may already have gone through. Please don't resend it or try the other option.",
      "Reopen the original unused-days offer email link to check the current status before doing anything else.", contact("If you can't find that email, contact "));
  }

  if (state.kind === "confirm") {
    request.then(function (res) {
      var url = res.ok ? safeCheckoutUrl(res.out.url) : null;
      if (url) {
        say("Email confirmed", el("p", {}, "Taking you to Stripe to pay. If nothing happens, ", el("a", { href: url }, "open the payment page"), "."));
        root.location.assign(url);
      } else if (res.ok && res.out.done === "paid") {
        say("This order is already paid", "We review every paid listing before it goes live, usually within 2 business days. You'll get an email when it's approved, with its dates.");
      } else if (res.ok && res.out.done === "pilot") {
        say("Your pilot is booked", "Thanks for confirming your email. We review every listing before it goes live, usually within 2 business days. You'll get an email when it's approved, with its dates.");
      } else {
        say("We couldn't confirm this link", serverMessage(res.out) || "The link may have expired. It works for 48 hours.", again, contact("Questions? Email "));
      }
    }).catch(function () { say("We couldn't confirm this link", failed); });
  } else if (state.kind === "credit") {
    request.then(function (res) {
      if (!res.ok) return say("This link doesn't work any more", serverMessage(res.out) || "It may have expired or already been used.", contact("Questions? Email "));
      var c = readCredit(res.out);
      if (c.processing) return choicePending();
      if (c.choice) return result(c.choice, c.cents, c.code);
      var amount = money(c.cents);
      if (!amount) return say("Your unused days", failed);
      var what = c.title && c.company ? c.title + " at " + c.company : c.title || "Your role";
      var refund = el("button", { type: "button", className: "cta" }, "Refund " + amount);
      var credit = el("button", { type: "button", className: "cta alt" }, "Get a code worth " + amount);
      say("Your unused days",
        what + " closed early, so its paid listing stopped. The unused days are worth " + amount + ". Choose one:",
        el("ul", { className: "plain" },
          el("li", {}, el("strong", {}, "A refund of " + amount), ", back to the way you paid."),
          el("li", {}, el("strong", {}, "A one-time code worth " + amount), " for another paid listing.")),
        el("p", { className: "choices" }, refund, " ", credit),
        "If you don't choose within 30 days, we refund it.");
      var pick = function (choice) {
        if (refund.disabled || credit.disabled) return;
        refund.disabled = credit.disabled = true;
        call("POST", "/employer/credit", { credit: state.credit, token: state.token, choice: choice }).then(function (r) {
          if (!r.ok) return choiceUnknown();
          var out = readCredit(r.out);
          if (out.processing) return choicePending();
          if (!out.choice) return choiceUnknown();
          result(out.choice, out.cents != null ? out.cents : c.cents, out.code);
        }).catch(choiceUnknown);
      };
      refund.addEventListener("click", function () { pick("refund"); });
      credit.addEventListener("click", function () { pick("credit"); });
    }).catch(function () { say("Your unused days", failed); });
  }

  function result(choice, cents, code) {
    var amount = money(cents);
    if (choice === "refund") return say("Refund on its way", "We've asked Stripe to refund " + (amount || "the unused days") + " to the way you paid.");
    if (code) {
      return say("Your code", el("p", {}, "Your one-time code" + (amount ? ", worth " + amount : "") + ": ", el("strong", { className: "code" }, code)),
        "Use it on the Stripe payment page when you pay for another paid listing. Keep it somewhere safe; it works once.", again);
    }
    return say("Your code", "We've made your code" + (amount ? ", worth " + amount : "") + ".", contact("If you don't have it, email "));
  }
}
