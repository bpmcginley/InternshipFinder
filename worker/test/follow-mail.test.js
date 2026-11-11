import assert from "node:assert/strict";
import test from "node:test";
import { renderFollowMail, sendFollowMail } from "../src/follow-mail.js";

const SITE = "https://site.example.test";
const ACTIONS = "https://actions.example.test";
const TOKEN = `10000000-0000-4000-8000-000000000001.${"a".repeat(64)}`;
const input = {
  from: "InternScout <sender@example.test>",
  to: "reader@example.test",
  postalAddress: "1 Synthetic Avenue\nFixture City, XY 00000",
  origins: [SITE, ACTIONS],
  links: {
    confirmation: `${ACTIONS}/confirm/fixture`,
    management: `${ACTIONS}/manage/fixture`,
    unsubscribe: `${ACTIONS}/unsubscribe/${TOKEN}`,
    matchingPage: `${SITE}/?field=swe`,
    publicShare: `${SITE}/share?role=1`,
  },
};
const role = (n, overrides = {}) => ({
  id: String(n).padStart(16, "0"),
  company_name: "Fixture Company",
  title: `Intern ${n}`,
  location: "Albany, NY",
  apply_url: `https://jobs.example.test/${n}`,
  ...overrides,
});
const footer = ["InternScout", input.postalAddress];

test("confirmation and management keep the approved exact plain-text templates", () => {
  const { links } = input;
  for (const [kind, subject, lines] of [
    [
      "confirm",
      "Confirm your InternScout follows",
      [
        "You asked for new internships matching Fixture Company.",
        `Confirm: ${links.confirmation}`,
        "This link expires in 7 days. If you did not ask for this, ignore this email. We will delete the request after 7 days.",
        `Delete this request: ${links.unsubscribe}`,
      ],
    ],
    [
      "manage",
      "Manage your InternScout follows",
      [
        `Manage your follows: ${links.management}`,
        "This link expires in 30 minutes. If you did not request it, ignore this email.",
        `Unsubscribe: ${links.unsubscribe}`,
      ],
    ],
  ]) {
    assert.deepEqual(renderFollowMail(kind, { ...input, summary: "Fixture\r\nCompany" }), {
      from: { name: "InternScout", email: "sender@example.test" },
      to: input.to,
      subject,
      text: [...lines, ...footer].join("\n"),
    });
  }
});

test("digest sends the exact approved copy and both RFC 8058 headers to the mock", async () => {
  const messages = [];
  const env = {
    EMAIL: {
      send: async (message) => {
        messages.push(message);
        return "accepted";
      },
    },
  };
  const first = role(1),
    duplicate = role(2, { apply_url: first.apply_url + "#apply" });
  const data = {
    ...input,
    matches: [first, first, duplicate],
    similar: [duplicate, role(3), role(3), role(4), role(5)],
  };
  assert.equal(await sendFollowMail(env, "digest", data), "accepted");
  const { links } = input;
  assert.deepEqual(messages, [
    {
      from: { name: "InternScout", email: "sender@example.test" },
      to: input.to,
      subject: "New internships for your follows",
      headers: {
        "List-Unsubscribe": `<${links.unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      text: [
        "New roles matching your follows:",
        "Fixture Company: Intern 1 (Albany, NY)",
        first.apply_url,
        "Two similar roles:",
        "Fixture Company: Intern 3 (Albany, NY)",
        role(3).apply_url,
        "Fixture Company: Intern 4 (Albany, NY)",
        role(4).apply_url,
        `See matching roles: ${links.matchingPage}`,
        `Share these roles: ${links.publicShare}`,
        "Always check the employer's posting before applying.",
        `Manage my follows: ${links.management}`,
        `Unsubscribe: ${links.unsubscribe}`,
        ...footer,
      ].join("\n"),
    },
  ]);
  assert.equal(await sendFollowMail(env, "digest", { matches: [], similar: [role(5)] }), null);
  assert.equal(messages.length, 1);
});

test("digest omits zero similar roles and uses singular copy for one distinct role", () => {
  const first = role(1);
  const digest = (similar) =>
    renderFollowMail("digest", { ...input, matches: [first], similar }).text;
  assert.doesNotMatch(digest([first]), /similar role/);
  assert.match(digest([first, role(2), role(2)]), /^One similar role:$/m);
});

test("unsafe links and addresses fail closed before reaching the binding", async () => {
  const env = { EMAIL: { send: () => assert.fail("Binding should stay untouched") } };
  const good = { ...input, matches: [role(1)] };
  for (const [name, value] of [
    ["unsubscribe", `http://actions.example.test/unsubscribe/${TOKEN}`],
    ["unsubscribe", `${ACTIONS}/unsubscribe#${TOKEN}`],
    ["unsubscribe", `${ACTIONS}/unsubscribe\r\nBcc:bad@example.test`],
    ["management", "https://actions.example.test.evil.test/manage"],
    ["matchingPage", "https://@site.example.test/path"],
    ["publicShare", `${SITE}/share?value=${TOKEN.replace(".", "%2E")}`],
  ]) {
    await assert.rejects(
      sendFollowMail(env, "digest", { ...good, links: { ...input.links, [name]: value } }),
      /Invalid follow message input/,
    );
  }
  for (const value of [
    "javascript:bad()",
    "https:///missing-authority",
    "https://u:p@jobs.example.test/1",
    "https://jobs.example.test:bad/1",
  ]) {
    await assert.rejects(
      sendFollowMail(env, "digest", { ...good, matches: [role(1, { apply_url: value })] }),
      /Invalid follow message input/,
    );
  }
  for (const override of [
    { from: "x@example.test\r\nBcc:bad@example.test" },
    { to: "reader@example.test,other@example.test" },
    { postalAddress: "" },
  ]) {
    await assert.rejects(
      sendFollowMail(env, "digest", { ...good, ...override }),
      /Invalid follow message input/,
    );
  }
});

test("follow transport calls once and hides provider message and recipient details on failure", async () => {
  let calls = 0;
  const env = {
    EMAIL: {
      send: async () => {
        calls++;
        throw new Error(`rejected ${input.to} ${TOKEN}`);
      },
    },
  };
  await assert.rejects(sendFollowMail(env, "manage", input), {
    message: "Follow mail attempt failed",
  });
  assert.equal(calls, 1);
  await assert.rejects(sendFollowMail({}, "manage", input), {
    message: "Follow mail is unavailable",
  });
});
