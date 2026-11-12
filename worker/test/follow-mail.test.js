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
    deleteRequest: `${ACTIONS}/delete-request/fixture`,
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
const unsubscribeHeaders = {
  "List-Unsubscribe": `<${input.links.unsubscribe}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

test("confirmation and management send exact plain-text templates and RFC 8058 headers", async () => {
  const { links } = input;
  for (const [kind, subject, lines] of [
    [
      "confirm",
      "Confirm your InternScout follows",
      [
        "You asked for new internships matching Fixture Company.",
        `Confirm: ${links.confirmation}`,
        "This link expires in 7 days. If you did not ask for this, ignore this email. We will delete the request after 7 days.",
        `Delete this request: ${links.deleteRequest}`,
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
    const env = { EMAIL: { send: async (message) => message } };
    assert.deepEqual(await sendFollowMail(env, kind, { ...input, summary: "Fixture\r\nCompany" }), {
      from: { name: "InternScout", email: "sender@example.test" },
      to: input.to,
      subject,
      text: [...lines, ...footer].join("\n"),
      headers: unsubscribeHeaders,
    });
  }
});

test("confirmation never labels the address-wide unsubscribe link as request-only deletion", () => {
  const confirmation = (deleteRequest) =>
    renderFollowMail("confirm", {
      ...input,
      summary: "Fixture Company",
      links: { ...input.links, deleteRequest },
    });
  for (const value of [
    undefined,
    input.links.unsubscribe,
    `${ACTIONS}/different-path/${TOKEN.replace(".", "%2E")}`,
    "https://unapproved.example.test/delete-request/fixture",
  ])
    assert.throws(() => confirmation(value), /Invalid follow message input/);
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
      headers: unsubscribeHeaders,
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

const CONFIRM_TOKEN = `20000000-0000-4000-8000-000000000002.${"b".repeat(64)}`;
const DELETE_TOKEN = `fd_30000000-0000-4000-8000-000000000003.${"c".repeat(64)}`;
const action = (purpose, token) => `${SITE}/follows/action.html#purpose=${purpose}&token=${token}`;
const actionLinks = {
  ...input.links,
  confirmation: action("confirm", CONFIRM_TOKEN),
  deleteRequest: action("delete-request", DELETE_TOKEN),
};

test("canonical purpose-specific action fragments appear only in confirmation body", () => {
  const legacy = renderFollowMail("confirm", { ...input, summary: "Fixture Company" });
  const message = renderFollowMail("confirm", {
    ...input,
    summary: "Fixture Company",
    links: actionLinks,
  });
  assert.deepEqual(message, {
    ...legacy,
    text: legacy.text
      .replace(input.links.confirmation, actionLinks.confirmation)
      .replace(input.links.deleteRequest, actionLinks.deleteRequest),
  });
  assert.deepEqual(message.headers, unsubscribeHeaders);
  assert.ok(!JSON.stringify({ ...message, text: undefined }).includes(CONFIRM_TOKEN));
  assert.ok(!JSON.stringify({ ...message, text: undefined }).includes(DELETE_TOKEN));
});

test("action fragments reject wrong purpose, token, origin, path and noncanonical fields before send", async () => {
  const env = { EMAIL: { send: () => assert.fail("No send for invalid action links") } };
  for (const [name, purpose, token] of [
    ["confirmation", "confirm", CONFIRM_TOKEN],
    ["deleteRequest", "delete-request", DELETE_TOKEN],
  ]) {
    const valid = action(purpose, token);
    const bad = [
      action(name === "confirmation" ? "delete-request" : "confirm", token),
      action(purpose, name === "confirmation" ? DELETE_TOKEN : CONFIRM_TOKEN),
      action(purpose, token.toUpperCase()),
      action(purpose, token.slice(0, -1)),
      action(purpose, token + "0"),
      action(purpose, token.replace(".", "%2E")),
      action(purpose, token.replace("-", "x")),
      valid.replace(SITE, "https://unapproved.example.test"),
      valid.replace("https:", "http:"),
      valid.replace("site.example.test", "user@site.example.test"),
      valid.replace("/follows/action.html", "/follows/other.html"),
      valid.replace("/follows/", "/follows/../follows/"),
      valid.replace("/follows/", "/%66ollows/"),
      valid.replace("#", "?"),
      valid.replace("#", "?#"),
      valid.replace("#", "?tracking=1#"),
      valid.replace("#", "#extra=1&"),
      valid + "&extra=1",
      valid + "&purpose=" + purpose,
      valid + "&token=" + token,
      `${SITE}/follows/action.html#token=${token}&purpose=${purpose}`,
      valid.replace("purpose=", "pur%70ose="),
      valid.replace("&token=", "&to%6ben="),
      valid.replace(`purpose=${purpose}`, "purpose=manage"),
      `${SITE}/follows/action.html#`,
      valid + "#",
    ];
    for (const value of bad)
      await assert.rejects(
        sendFollowMail(env, "confirm", {
          ...input,
          summary: "Fixture Company",
          links: { ...actionLinks, [name]: value },
        }),
        { message: "Invalid follow message input" },
      );
  }
});

test("action fragments stay in their purpose and tokens stay out of public links", () => {
  for (const name of ["unsubscribe", "management"]) {
    for (const value of [
      actionLinks.confirmation,
      actionLinks.deleteRequest,
      `${input.links[name]}#`,
    ])
      assert.throws(
        () => renderFollowMail("manage", { ...input, links: { ...input.links, [name]: value } }),
        /Invalid follow message input/,
      );
  }
  for (const name of ["matchingPage", "publicShare"]) {
    for (const value of [
      actionLinks.confirmation,
      actionLinks.deleteRequest,
      actionLinks.confirmation.replace(CONFIRM_TOKEN, CONFIRM_TOKEN.replace(".", "%2E")),
    ])
      assert.throws(
        () =>
          renderFollowMail("digest", {
            ...input,
            matches: [role(1)],
            links: { ...input.links, [name]: value },
          }),
        /Invalid follow message input/,
      );
  }
  assert.throws(
    () =>
      renderFollowMail("confirm", {
        ...input,
        summary: "Fixture Company",
        links: { ...actionLinks, deleteRequest: action("delete-request", `fd_${TOKEN}`) },
      }),
    /Invalid follow message input/,
    "address-wide unsubscribe token cannot become request deletion",
  );
});

const MANAGEMENT_TOKEN = `40000000-0000-4000-8000-000000000004.${"d".repeat(64)}`;
const MANAGEMENT_LINK = `https://internscout.org/follows/manage.html#token=${MANAGEMENT_TOKEN}`;
const managementInput = {
  ...input,
  origins: [...input.origins, "https://internscout.org"],
  links: { ...actionLinks, management: MANAGEMENT_LINK },
  matches: [role(1)],
  summary: "Fixture Company",
};

test("the first-party management capability appears only in the management and digest bodies", () => {
  for (const [kind, label] of [
    ["manage", "Manage your follows"],
    ["digest", "Manage my follows"],
  ]) {
    const message = renderFollowMail(kind, managementInput);
    assert.ok(message.text.split("\n").includes(`${label}: ${MANAGEMENT_LINK}`));
    assert.deepEqual(message.headers, unsubscribeHeaders);
    const { text, ...envelope } = message;
    assert.equal(text.split(MANAGEMENT_TOKEN).length, 2);
    assert.ok(!JSON.stringify(envelope).includes(MANAGEMENT_TOKEN));
  }
});

test("management links reject normalized variants and stay out of every other link slot", async () => {
  let sends = 0;
  const env = { EMAIL: { send: () => sends++ } };
  const invalid = { message: "Invalid follow message input" };
  const mail = (kind, name, value) =>
    sendFollowMail(env, kind, {
      ...managementInput,
      links: { ...managementInput.links, [name]: value },
    });
  for (const value of [
    MANAGEMENT_LINK.replace("https:", "http:"),
    MANAGEMENT_LINK.replace("internscout.org", "internscout.org:443"),
    MANAGEMENT_LINK.replace("internscout.org", "user@internscout.org"),
    MANAGEMENT_LINK.replace("https://internscout.org", SITE),
    MANAGEMENT_LINK.replace("/follows/", "/follows/../follows/"),
    MANAGEMENT_LINK.replace("manage.html", "man%61ge.html"),
    MANAGEMENT_LINK.replace("manage.html", "other.html"),
    MANAGEMENT_LINK.replace("#", "?"),
    MANAGEMENT_LINK.replace("#", "?tracking=1#"),
    MANAGEMENT_LINK.replace("token=", "to%6ben="),
    MANAGEMENT_LINK.replace(MANAGEMENT_TOKEN, MANAGEMENT_TOKEN.toUpperCase()),
    MANAGEMENT_LINK.replace(MANAGEMENT_TOKEN, MANAGEMENT_TOKEN.replace(".", "%2E")),
    MANAGEMENT_LINK + "&token=" + MANAGEMENT_TOKEN,
    MANAGEMENT_LINK + "#",
    MANAGEMENT_LINK.split("#")[0],
  ])
    await assert.rejects(mail("manage", "management", value), invalid);

  for (const [kind, name] of [
    ["confirm", "confirmation"],
    ["confirm", "deleteRequest"],
    ["manage", "unsubscribe"],
    ["digest", "matchingPage"],
    ["digest", "publicShare"],
  ])
    await assert.rejects(mail(kind, name, MANAGEMENT_LINK), invalid);
  assert.equal(sends, 0);
});

test("encoded reserved action paths cannot fall through to legacy query links", () => {
  for (const name of ["confirmation", "deleteRequest", "management", "unsubscribe"]) {
    for (const path of ["/%66ollows/action.html", "/follows/act%69on.html"]) {
      for (const suffix of ["", `?purpose=confirm&token=${CONFIRM_TOKEN}`]) {
        assert.throws(
          () =>
            renderFollowMail(name === "management" ? "manage" : "confirm", {
              ...input,
              summary: "Fixture Company",
              links: { ...input.links, [name]: SITE + path + suffix },
            }),
          /Invalid follow message input/,
        );
      }
    }
  }
  const legacy = `${ACTIONS}/legacy/%66ollow?token=fixture`;
  const message = renderFollowMail("confirm", {
    ...input,
    summary: "Fixture Company",
    links: { ...input.links, confirmation: legacy },
  });
  assert.ok(message.text.includes(`Confirm: ${legacy}`));
});
