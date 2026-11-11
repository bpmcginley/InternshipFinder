// Synthetic archetypes expanded across five shard shapes to exercise multiple dashboard batches.
export const LISTING_CLOCK = Date.parse("2026-11-03T12:00:00Z");

export const MAJORS = {
  majors: [
    { name: "Computer Science", tags: ["swe"], related: ["data"] },
    { name: "Nursing", tags: ["nursing"], related: ["health"] },
  ],
};

const places = {
  MA: "Boston, MA",
  NY: "Albany, NY",
  CA: "Oakland, CA",
  TX: "Austin, TX",
  remote: "Remote",
};

const roles = [
  { title: "Software Engineer Intern", field_tags: ["swe"], years: ["junior"], salary: "$30/hour" },
  { title: "Software Research Intern", field_tags: ["swe"], status: "closed" },
  { title: "Nursing Intern", field_tags: ["nursing", "health"], years: ["sophomore"] },
  { title: "Data Analyst Intern", field_tags: ["data"], stage: ["coop"] },
  { title: "Software Developer Intern", field_tags: ["swe"], restrictions: ["us_citizen_only"] },
  { title: "Marketing Intern", field_tags: ["business"], restrictions: ["paid"], is_remote: true },
  { title: "Unpaid Marketing Intern", field_tags: ["business"], restrictions: ["unpaid"] },
  { title: "Clinical Research Intern", field_tags: ["health"], posted_at: null },
  { title: "Data Engineer Intern", field_tags: ["data", "swe"], salary: "$25/hour" },
  { title: "Research Fellow", field_tags: ["science"], stage: ["fellowship"], description: "Work alongside a software engineer" },
];

function shard(key) {
  const remote = key === "remote";
  const region = { loc: places[key], state: remote ? null : key, kind: remote ? "remote" : "us" };
  return Array.from({ length: 520 }, (_, i) => ({
    id: key + "-" + i,
    // Distinct listings can point at the same application.
    apply_url: "https://jobs.example/" + key + "/" + (i === 1 ? 0 : i),
    company_name: "Example Employer " + (i % 23),
    sector: i % 2 ? "healthcare" : "technology",
    status: "open",
    regions: [region],
    is_remote: remote,
    stage: ["internship"],
    term: "Summer 2027",
    first_seen: "2026-11-02T09:00:00Z",
    posted_at: "2026-10-" + String(10 + (i % 20)),
    is_new: i % 3 === 0,
    ats: i % 2 ? "greenhouse" : "workable",
    ...roles[i % roles.length],
  }));
}

export function listingRows() {
  const shards = Object.keys(places).map(shard);
  // The same listing can be present in more than one shard.
  shards.at(-1).push({ ...shards[0][0] });
  const byId = new Map();
  for (const row of shards.flat()) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}
