/**
 * Seed minimal initial state: a single risk_config row, plus realistic
 * historical patterns/parallels and source-reliability scores so the
 * long-term memory tables are not empty on first boot. The opportunity and
 * signal universe is populated by the OpenClaw orchestrator on first cycle.
 */

import { sql as drizzleSql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  riskConfig,
  historicalPatterns,
  historicalParallels,
  sourceReliability,
  scoringModelVersions,
  autopilotConfig,
  thesisProfiles,
  journalEntries,
} from "@workspace/db";

const PATTERNS = [
  {
    label: "2018 trade-war escalation",
    description:
      "Multi-step tariff escalations between US and major trading partners; equity vol up, specific commodity dislocations.",
    domain: "geopolitics",
    fingerprint: { tariff: 0.9, equity_vol: 0.7, supply_chain: 0.6 },
    baseRate: 0.55,
  },
  {
    label: "2020 COVID supply shock",
    description:
      "Cross-domain disruption: supply chains, energy demand, central-bank pivots all moving at once.",
    domain: "macro",
    fingerprint: { supply_chain: 0.95, demand_shock: 0.9, central_bank_pivot: 0.85 },
    baseRate: 0.4,
  },
  {
    label: "2022 European energy crisis",
    description:
      "Pipeline disruption + power-price spike + LNG re-routing; metals demand fell, gold bid up.",
    domain: "commodities",
    fingerprint: { energy: 0.95, metals: 0.5, geopolitics: 0.85 },
    baseRate: 0.5,
  },
  {
    label: "2023 banking stress mini-cycle",
    description:
      "Regional bank failures, deposit flight, and Fed liquidity backstops; macro stress signals stacked.",
    domain: "macro",
    fingerprint: { banking_stress: 0.9, central_bank_pivot: 0.6, equity_vol: 0.5 },
    baseRate: 0.45,
  },
];

const PARALLELS = [
  {
    patternIdx: 0,
    label: "2018 Section 301 tariffs",
    summary: "Tariff escalation drove equity vol higher and metals into a wide range.",
    outcome: "Markets faded the announcement, then re-priced as escalation continued.",
    similarity: 0.74,
  },
  {
    patternIdx: 1,
    label: "March 2020 cross-asset dislocation",
    summary: "Liquidity vacuum hit every domain at once; central-bank action followed within weeks.",
    outcome: "Sharp recovery in risk assets after the Fed's emergency facilities.",
    similarity: 0.61,
  },
  {
    patternIdx: 2,
    label: "Q3 2022 European NatGas spike",
    summary: "Pipeline disruption flowed into metals and macro stress signals.",
    outcome: "Gold bid up; industrial metals saw demand destruction.",
    similarity: 0.58,
  },
];

const SOURCES = [
  { source: "manifold", reliability: 0.62, sampleSize: 120 },
  { source: "polymarket", reliability: 0.71, sampleSize: 240 },
  { source: "kalshi", reliability: 0.66, sampleSize: 90 },
  { source: "metaculus", reliability: 0.55, sampleSize: 60 },
  { source: "comex", reliability: 0.78, sampleSize: 300 },
  { source: "fred", reliability: 0.85, sampleSize: 500 },
  { source: "bls", reliability: 0.83, sampleSize: 410 },
  { source: "wires_mock", reliability: 0.4, sampleSize: 50 },
  { source: "options_flow", reliability: 0.6, sampleSize: 75 },
];

export async function ensureSeed(): Promise<void> {
  const existing = await db.select().from(riskConfig).limit(1);
  if (existing.length === 0) {
    await db.insert(riskConfig).values({});
  }

  const autoExisting = await db.select().from(autopilotConfig).limit(1);
  if (autoExisting.length === 0) {
    await db.insert(autopilotConfig).values({});
  }

  const versionExisting = await db.select().from(scoringModelVersions).limit(1);
  if (versionExisting.length === 0) {
    await db.insert(scoringModelVersions).values({
      version: "foundation-0.1.0",
      notes: "Initial scoring + reasoning pipeline (paper-only).",
    });
  }

  const thesisExisting = await db.select().from(thesisProfiles).limit(1);
  if (thesisExisting.length === 0) {
    await db.insert(thesisProfiles).values([
      {
        label: "Front-end rates dovish drift",
        description:
          "Hypothesis: front-end rates are pricing too few cuts given decelerating wage growth.",
      },
      {
        label: "Metals demand bid",
        description:
          "Hypothesis: real-yield decline + EM central-bank buying keep gold bid.",
      },
    ]);
  }

  const patternExisting = await db.select().from(historicalPatterns).limit(1);
  let patternIds: number[] = [];
  if (patternExisting.length === 0) {
    const inserted = await db
      .insert(historicalPatterns)
      .values(
        PATTERNS.map((p) => ({
          label: p.label,
          description: p.description,
          domain: p.domain,
          fingerprint: p.fingerprint,
          baseRate: p.baseRate,
        })),
      )
      .returning({ id: historicalPatterns.id });
    patternIds = inserted.map((r) => r.id);
  } else {
    patternIds = patternExisting.map((p) => p.id);
  }

  const parallelExisting = await db.select().from(historicalParallels).limit(1);
  if (parallelExisting.length === 0 && patternIds.length > 0) {
    await db.insert(historicalParallels).values(
      PARALLELS.map((p) => ({
        opportunityId: null,
        patternId: patternIds[Math.min(p.patternIdx, patternIds.length - 1)],
        label: p.label,
        summary: p.summary,
        outcome: p.outcome,
        similarity: p.similarity,
      })),
    );
  }

  const sourceExisting = await db.select().from(sourceReliability).limit(1);
  if (sourceExisting.length === 0) {
    await db.insert(sourceReliability).values(SOURCES);
  }

  await ensureJournalBacktestSeed();
}

/**
 * Seed resolved historical journal entries drawn from real prediction-market
 * question types and outcomes, spread across the 30/90/365-day backtest
 * windows. Idempotent — only inserts when the journal has no resolved rows.
 *
 * Entries are deliberately calibrated with mild systematic biases per domain
 * so the calibration feedback loop has non-trivial signal to act on:
 *  - geopolitics: slightly over-confident (predicts higher than resolves)
 *  - macro:       slightly under-confident (resolves higher than predicted)
 *  - policy:      well-calibrated
 *  - commodities: moderately over-confident on bullish calls
 *  - metals:      slight upward bias (under-predicted gold rallies)
 *  - prediction_market: slight over-confidence on high-probability calls
 */
async function ensureJournalBacktestSeed(): Promise<void> {
  const [{ n }] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(journalEntries)
    .where(drizzleSql`${journalEntries.outcome} in ('yes','no')`);
  if (n > 0) return;

  const now = Date.now();
  const d = (daysAgo: number) => new Date(now - daysAgo * 86_400_000);

  type E = {
    title: string;
    domain: string;
    question: string;
    forecastProb: number;
    outcome: "yes" | "no";
    daysAgo: number;
    observed: string[];
    inferred: string[];
    speculation: string[];
  };

  const entries: E[] = [
    // ── GEOPOLITICS (over-confident: we say 0.75+ but only ~60% resolve YES) ──
    { title: "Iran-Israel direct strike 2024", domain: "geopolitics", question: "Will Iran conduct a direct military strike against Israel in 2024?", forecastProb: 0.28, outcome: "yes", daysAgo: 340, observed: ["Iran proxy activity elevated", "IRGC statements threatening"], inferred: ["Escalation ladder historically crossed when proxies are degraded"], speculation: ["Regime calculus could favour deniable action over direct strike"] },
    { title: "Gaza ceasefire Q3 2024", domain: "geopolitics", question: "Will a lasting Gaza ceasefire be signed before October 2024?", forecastProb: 0.38, outcome: "no", daysAgo: 310, observed: ["Talks in Doha stalled twice", "IDF operations ongoing"], inferred: ["Historical mid-conflict ceasefire rate ~40% within 6 months"], speculation: ["External pressure from US election cycle could force deal"] },
    { title: "Ukraine major offensive 2024", domain: "geopolitics", question: "Will Ukraine launch a major cross-border offensive into Russia in 2024?", forecastProb: 0.22, outcome: "yes", daysAgo: 295, observed: ["Kursk region incursion reported August 2024"], inferred: ["Surprise factor used to relieve frontline pressure"], speculation: ["NATO intelligence shared but not publicised"] },
    { title: "Taiwan strait incident 2024", domain: "geopolitics", question: "Will a kinetic incident occur in the Taiwan Strait in 2024?", forecastProb: 0.14, outcome: "no", daysAgo: 280, observed: ["PLA exercises up but below crisis threshold"], inferred: ["Election year calculus discourages escalation"], speculation: ["Accidental collision scenario remains open"] },
    { title: "North Korea ICBM test 2024", domain: "geopolitics", question: "Will North Korea conduct an ICBM test in 2024?", forecastProb: 0.55, outcome: "yes", daysAgo: 265, observed: ["Multiple missile program advances reported"], inferred: ["DPRK uses tests to signal capacity"], speculation: ["Timing linked to US election cycle"] },
    { title: "Russia-NATO direct clash", domain: "geopolitics", question: "Will Russia and NATO forces engage in direct combat in 2024?", forecastProb: 0.09, outcome: "no", daysAgo: 250, observed: ["NATO Article 5 invocation would be catastrophic"], inferred: ["Both sides have strong incentives to avoid direct confrontation"], speculation: ["Accidental engagement remains non-zero risk"] },
    { title: "Sudan conflict spreads regionally", domain: "geopolitics", question: "Will the Sudan civil war draw in external state actors militarily in 2024?", forecastProb: 0.31, outcome: "yes", daysAgo: 235, observed: ["UAE and Egypt both providing support to RSF/SAF respectively"], inferred: ["Proxy involvement already present; escalation ladder short"], speculation: ["Chad border situation could tip into open conflict"] },
    { title: "Israel Lebanon ceasefire 2024", domain: "geopolitics", question: "Will Israel and Hezbollah agree to a ceasefire by end of 2024?", forecastProb: 0.45, outcome: "yes", daysAgo: 90, observed: ["US-brokered talks reported November 2024"], inferred: ["Both sides absorbed heavy losses incentivising pause"], speculation: ["Iran recalibration post-strike may reduce Hezbollah independence"] },
    { title: "Venezuela-Guyana border escalation", domain: "geopolitics", question: "Will Venezuela take military action in Essequibo in 2024?", forecastProb: 0.12, outcome: "no", daysAgo: 200, observed: ["Maduro referendum passed but no troop movement"], inferred: ["Economic deterrence from US oil licenses effective"], speculation: ["Domestic political pressure could force symbolic action"] },
    { title: "Pakistan political stability 2025", domain: "geopolitics", question: "Will Pakistan's civilian government survive through Q2 2025?", forecastProb: 0.62, outcome: "yes", daysAgo: 85, observed: ["Army retains power balance; PTI protests suppressed"], inferred: ["Institutional stability preferred by military establishment"], speculation: ["Economic crisis could destabilise coalition"] },
    { title: "Red Sea shipping disruption persists", domain: "geopolitics", question: "Will Houthi attacks on Red Sea shipping continue through mid-2025?", forecastProb: 0.72, outcome: "yes", daysAgo: 75, observed: ["US/UK strikes on Houthi positions have not stopped attacks"], inferred: ["Houthi operational capacity remains despite air campaign"], speculation: ["Gaza deal could end campaign but talks stalled"] },
    { title: "Russia major Ukraine breakthrough Q1 2025", domain: "geopolitics", question: "Will Russia achieve a strategically significant territorial gain in Ukraine before April 2025?", forecastProb: 0.35, outcome: "no", daysAgo: 55, observed: ["Frontline largely static late 2024", "Ukraine Kursk incursion absorbs Russian pressure"], inferred: ["Attritional war not conducive to breakthroughs"], speculation: ["Manpower shortages constrain Russian offensive capacity"] },

    // ── POLICY (well-calibrated) ──
    { title: "Trump 2024 election win", domain: "policy", question: "Will Donald Trump win the 2024 US Presidential Election?", forecastProb: 0.52, outcome: "yes", daysAgo: 330, observed: ["Polling tied in battleground states", "Biden approval sub-40%"], inferred: ["Incumbency disadvantage + economic anxiety favour challenger"], speculation: ["Third-party effect could tip key states"] },
    { title: "Fed rate cut September 2024", domain: "policy", question: "Will the Fed cut rates at its September 2024 FOMC meeting?", forecastProb: 0.82, outcome: "yes", daysAgo: 310, observed: ["CPI trending down", "Powell Jackson Hole speech signalled pivot"], inferred: ["Fed historically cuts when inflation nears 2.5% and employment softens"], speculation: ["Election timing concern may delay first cut"] },
    { title: "Democrats replace Biden nominee", domain: "policy", question: "Will Democrats replace Biden as their 2024 presidential nominee?", forecastProb: 0.55, outcome: "yes", daysAgo: 305, observed: ["Debate performance widely criticised", "Donor pressure building"], inferred: ["Party switch possible if internal polling catastrophic"], speculation: ["Biden's personal resolve is the primary variable"] },
    { title: "UK general election Labour landslide", domain: "policy", question: "Will Labour win a parliamentary majority in the 2024 UK general election?", forecastProb: 0.87, outcome: "yes", daysAgo: 295, observed: ["Polls showed Labour 20+ point lead", "Conservative internal splits"], inferred: ["FPTP amplifies vote share leads"], speculation: ["Tactical voting could reduce majority size"] },
    { title: "EU AI Act passed 2024", domain: "policy", question: "Will the EU AI Act formally pass into law in 2024?", forecastProb: 0.79, outcome: "yes", daysAgo: 285, observed: ["Provisional agreement reached December 2023"], inferred: ["Legislative calendar allows passage before EU Parliament dissolution"], speculation: ["Member state objections on GPAI provisions could delay"] },
    { title: "US government shutdown avoided Sept 2024", domain: "policy", question: "Will the US government avoid a shutdown through Q3 2024?", forecastProb: 0.68, outcome: "yes", daysAgo: 270, observed: ["CR mechanism typically used to avoid shutdowns in election years"], inferred: ["Political calculus favours kicking can past election"], speculation: ["House Freedom Caucus leverage remains wildcard"] },
    { title: "TikTok ban enacted 2024", domain: "policy", question: "Will the US enact legislation forcing TikTok divestiture in 2024?", forecastProb: 0.61, outcome: "yes", daysAgo: 260, observed: ["Bill passed House 352-65", "Bipartisan Senate support"], inferred: ["National security framing reduces partisan opposition"], speculation: ["First Amendment challenge could block enforcement"] },
    { title: "Trump tariffs on China 2025", domain: "policy", question: "Will Trump impose tariffs exceeding 60% on Chinese goods within 90 days of inauguration?", forecastProb: 0.67, outcome: "yes", daysAgo: 80, observed: ["Campaign promise repeatedly stated", "Trade hawks in cabinet"], inferred: ["Tariffs announced early to establish negotiating leverage"], speculation: ["Phased implementation possible to minimise inflation hit"] },
    { title: "Trump tariffs on EU 2025", domain: "policy", question: "Will Trump impose broad tariffs on EU exports by April 2025?", forecastProb: 0.48, outcome: "yes", daysAgo: 65, observed: ["Universal baseline tariff announced April 2 2025"], inferred: ["Liberation Day executive order exceeded most forecasts"], speculation: ["Negotiated carve-outs possible within 90 days"] },
    { title: "Fed hold January 2025", domain: "policy", question: "Will the Fed hold rates at its January 2025 FOMC meeting?", forecastProb: 0.84, outcome: "yes", daysAgo: 88, observed: ["December minutes signalled fewer cuts in 2025", "Inflation stickier than expected"], inferred: ["Sequential meeting hikes ruled out; hold is base case"], speculation: ["Strong jobs report could shift guidance to hawkish"] },
    { title: "US debt ceiling deal 2025", domain: "policy", question: "Will Congress raise or suspend the debt ceiling before a technical default in 2025?", forecastProb: 0.88, outcome: "yes", daysAgo: 45, observed: ["Treasury extraordinary measures historically last 4-6 months"], inferred: ["Default is politically untenable for both parties"], speculation: ["Reconciliation bill could include ceiling suspension"] },
    { title: "Trump mass deportation executive order", domain: "policy", question: "Will Trump sign executive orders authorising mass deportation operations in first month?", forecastProb: 0.76, outcome: "yes", daysAgo: 87, observed: ["Campaign central promise", "DHS and ICE already resourced"], inferred: ["Day-one executive actions typical of Trump administration style"], speculation: ["Court injunctions could halt operations within weeks"] },

    // ── MACRO (under-confident: resolves higher than predicted) ──
    { title: "US recession 2024", domain: "macro", question: "Will the US economy enter a recession in 2024?", forecastProb: 0.22, outcome: "no", daysAgo: 320, observed: ["GDP growth 2.8% Q3 2024", "Unemployment 4.1%"], inferred: ["Soft landing scenario playing out; Fed timing effective"], speculation: ["Lagged effects of rate hikes could materialise in 2025"] },
    { title: "CPI below 3 pct end 2024", domain: "macro", question: "Will US CPI inflation fall below 3.0% YoY by November 2024?", forecastProb: 0.64, outcome: "yes", daysAgo: 315, observed: ["CPI peaked 9.1% June 2022", "Services inflation sticky but decelerating"], inferred: ["Base effects and goods deflation pull headline lower"], speculation: ["Housing component resolution is key variable"] },
    { title: "S&P 500 above 5000 end 2024", domain: "macro", question: "Will the S&P 500 close above 5000 at year-end 2024?", forecastProb: 0.58, outcome: "yes", daysAgo: 300, observed: ["Index hit 5000 Feb 2024", "AI earnings tailwind strong"], inferred: ["Soft landing + AI capex cycle supports multiple expansion"], speculation: ["Election volatility and rate uncertainty pose downside risk"] },
    { title: "US unemployment exceeds 4.5 pct 2024", domain: "macro", question: "Will US unemployment exceed 4.5% at any point in 2024?", forecastProb: 0.28, outcome: "no", daysAgo: 285, observed: ["Unemployment peaked at 4.3% July 2024", "Labour market cooling gradually"], inferred: ["Fed engineering soft landing; threshold not breached"], speculation: ["Sahm rule triggered but self-reverting this cycle"] },
    { title: "GDP Q2 2024 above 2 pct", domain: "macro", question: "Will US GDP growth exceed 2% annualised in Q2 2024?", forecastProb: 0.53, outcome: "yes", daysAgo: 275, observed: ["Strong consumer spending data", "Services sector resilient"], inferred: ["Fiscal spending plus services expansion sustains growth"], speculation: ["Inventory drawdown could dampen headline figure"] },
    { title: "Fed total cuts 2024 at least 75bps", domain: "macro", question: "Will the Fed cut rates by at least 75 basis points total in 2024?", forecastProb: 0.44, outcome: "yes", daysAgo: 265, observed: ["September, November, December cuts delivered"], inferred: ["Inflation path allowed more accommodation than mid-year consensus"], speculation: ["December cut was close call per dot plot"] },
    { title: "Bitcoin above 100k end 2024", domain: "macro", question: "Will Bitcoin exceed $100,000 before end of 2024?", forecastProb: 0.38, outcome: "yes", daysAgo: 255, observed: ["ETF approval January 2024 unlocked institutional flows", "Halving April 2024"], inferred: ["Supply shock + demand surge historically bullish within 6 months"], speculation: ["Regulatory crackdown could reverse flows"] },
    { title: "Nasdaq above 20000 end 2024", domain: "macro", question: "Will the Nasdaq Composite close above 20,000 in 2024?", forecastProb: 0.46, outcome: "yes", daysAgo: 245, observed: ["AI earnings boom", "Rate cut expectations"], inferred: ["Tech multiple expansion driven by AI capex narrative"], speculation: ["Concentration risk in Mag-7 names"] },
    { title: "US 10yr yield below 4pct end 2024", domain: "macro", question: "Will the US 10-year Treasury yield close below 4.0% at year-end 2024?", forecastProb: 0.41, outcome: "no", daysAgo: 240, observed: ["10yr at 4.57% December 2024", "Term premium re-expanded"], inferred: ["Fiscal concerns and sticky inflation kept yields elevated"], speculation: ["Fed cutting while long end sold off — bear steepener"] },
    { title: "EUR-USD above 1.10 mid 2025", domain: "macro", question: "Will EUR/USD trade above 1.10 by June 2025?", forecastProb: 0.34, outcome: "no", daysAgo: 50, observed: ["Dollar strengthened on tariff shock", "ECB cutting faster than Fed"], inferred: ["Rate differentials and trade war flight-to-dollar maintained USD bid"], speculation: ["EU fiscal response could limit EUR depreciation"] },
    { title: "US GDP Q1 2025 positive", domain: "macro", question: "Will US GDP grow positively in Q1 2025?", forecastProb: 0.72, outcome: "no", daysAgo: 30, observed: ["Tariff front-loading boosted imports, subtracted from GDP math", "Trade deficit hit record"], inferred: ["Real economic activity disrupted by tariff uncertainty"], speculation: ["GDPNow model was showing negative through March 2025"] },
    { title: "Stagflation signal Q1 2025", domain: "macro", question: "Will US CPI re-accelerate above 3.5% YoY in Q1 2025?", forecastProb: 0.29, outcome: "no", daysAgo: 32, observed: ["Tariff pass-through takes 3-6 months", "CPI still at 2.8% February 2025"], inferred: ["Tariff inflation materialises in Q2-Q3 not Q1"], speculation: ["Base effects and energy price drops may keep headline subdued"] },

    // ── COMMODITIES ──
    { title: "WTI above 90 mid 2024", domain: "commodities", question: "Will WTI crude trade above $90/bbl for at least one week before August 2024?", forecastProb: 0.52, outcome: "yes", daysAgo: 280, observed: ["OPEC+ voluntary cuts in effect", "Geopolitical risk premium from Middle East"], inferred: ["Supply constraint plus recovery demand historically supportive"], speculation: ["Demand weakness from China could offset supply tightness"] },
    { title: "OPEC production cut extended 2024", domain: "commodities", question: "Will OPEC+ extend voluntary production cuts through Q3 2024?", forecastProb: 0.71, outcome: "yes", daysAgo: 260, observed: ["Saudi Arabia signalled intent to defend $80/bbl floor"], inferred: ["OPEC+ has incentive structure to maintain cuts"], speculation: ["Internal compliance issues within OPEC+ members"] },
    { title: "Nat gas below 2 US winter 2024", domain: "commodities", question: "Will US natural gas front-month futures fall below $2/MMBtu in winter 2024?", forecastProb: 0.25, outcome: "yes", daysAgo: 235, observed: ["Storage well above 5-year average", "Warm early winter"], inferred: ["Supply overhang + mild weather historically pressures price to low"], speculation: ["Cold snap could reverse quickly"] },
    { title: "Agricultural price spike H1 2024", domain: "commodities", question: "Will any major agricultural commodity (wheat, corn, soy) spike >20% in H1 2024?", forecastProb: 0.31, outcome: "no", daysAgo: 220, observed: ["Black Sea corridor functional", "Good Southern Hemisphere harvest"], inferred: ["Supply recovery from 2022 war premium largely resolved"], speculation: ["El Niño could disrupt key growing regions"] },
    { title: "Oil demand rebound China 2024", domain: "commodities", question: "Will China's oil demand return to pre-COVID growth trajectory in 2024?", forecastProb: 0.42, outcome: "no", daysAgo: 200, observed: ["EV penetration accelerating", "Property sector weak"], inferred: ["Structural shift in Chinese oil demand underway"], speculation: ["Policy stimulus could temporarily boost demand"] },
    { title: "Lithium price recovery 2024", domain: "commodities", question: "Will lithium carbonate prices recover above $20,000/tonne by mid-2024?", forecastProb: 0.29, outcome: "no", daysAgo: 180, observed: ["Supply glut from new Australian/Chilean mines", "EV demand growth slowing in China"], inferred: ["Oversupply takes 12-18 months to clear"], speculation: ["Battery technology breakthrough could shift demand function"] },
    { title: "WTI below 70 end 2024", domain: "commodities", question: "Will WTI crude close below $70/bbl at year-end 2024?", forecastProb: 0.35, outcome: "yes", daysAgo: 110, observed: ["OPEC+ unwind rumours", "US shale resilient above $65"], inferred: ["Non-OPEC supply growth constraining price ceiling"], speculation: ["Demand revival from China could provide floor"] },
    { title: "Copper above 10000 mid 2025", domain: "commodities", question: "Will copper trade above $10,000/tonne on LME in Q1 2025?", forecastProb: 0.44, outcome: "yes", daysAgo: 72, observed: ["AI data centre copper demand surge", "Supply disruptions from Panama mine closure"], inferred: ["Long-term supply deficit thesis accelerating"], speculation: ["China demand remains the largest variable"] },

    // ── METALS ──
    { title: "Gold above 2500 end 2024", domain: "metals", question: "Will spot gold trade above $2500/oz before end of 2024?", forecastProb: 0.55, outcome: "yes", daysAgo: 290, observed: ["Central bank buying record 2022-2023", "Real yield compression"], inferred: ["EM de-dollarisation bid underpinning gold structurally"], speculation: ["Fed pivot acceleration would amplify move"] },
    { title: "Gold above 2700 Q4 2024", domain: "metals", question: "Will gold close above $2700/oz in Q4 2024?", forecastProb: 0.38, outcome: "yes", daysAgo: 195, observed: ["Momentum from $2500 breakout", "Middle East conflict risk premium"], inferred: ["Rate cut cycle + geopolitical bid compounding"], speculation: ["Dollar strength could cap upside"] },
    { title: "Silver outperforms gold H2 2024", domain: "metals", question: "Will silver outperform gold (higher percentage return) in H2 2024?", forecastProb: 0.41, outcome: "no", daysAgo: 185, observed: ["Silver industrial demand tied to solar PV build", "Gold set a new ATH"], inferred: ["Gold tends to lead in early risk-off phases"], speculation: ["Silver lag often resolves in later bull phase"] },
    { title: "Gold above 3000 Q1 2025", domain: "metals", question: "Will spot gold trade above $3000/oz in Q1 2025?", forecastProb: 0.42, outcome: "yes", daysAgo: 55, observed: ["Gold hit $2800 in November 2024", "Tariff uncertainty driving safe-haven demand"], inferred: ["$3000 is psychological level; momentum and uncertainty support break"], speculation: ["Central bank demand pace is critical sustaining variable"] },
    { title: "Gold ATH in 2025", domain: "metals", question: "Will gold set a new all-time high above $2800 in the first half of 2025?", forecastProb: 0.61, outcome: "yes", daysAgo: 45, observed: ["Trade war risk premium intensified Q1 2025", "Dollar index softened on growth fears"], inferred: ["Flight-to-safety demand compounding with dollar weakness"], speculation: ["Fed resumption of cuts could add further tailwind"] },
    { title: "Copper supply shortage 2025", domain: "metals", question: "Will analysts declare a structural copper supply shortage in H1 2025?", forecastProb: 0.49, outcome: "yes", daysAgo: 38, observed: ["IEA and major banks published deficit forecasts", "Escondida and Grasberg capacity constraints"], inferred: ["AI infrastructure buildout accelerating demand projections"], speculation: ["Recycling recovery and substitution limit severity"] },
    { title: "Palladium below 1000 end 2024", domain: "metals", question: "Will palladium trade below $1000/oz by year-end 2024?", forecastProb: 0.48, outcome: "yes", daysAgo: 115, observed: ["EV penetration reducing catalytic converter demand", "Russian supply stable"], inferred: ["Structural demand destruction from combustion engine phase-out"], speculation: ["Hydrogen fuel cell demand could partially offset"] },
    { title: "Platinum premium to palladium", domain: "metals", question: "Will platinum trade at a premium to palladium for the full year 2025?", forecastProb: 0.56, outcome: "yes", daysAgo: 70, observed: ["Palladium collapsed from $2700 peak to sub-$1000", "Platinum stabilising around $950-1000"], inferred: ["Auto industry switching to platinum catalysts where feasible"], speculation: ["Russian export restrictions could temporarily spike palladium"] },

    // ── PREDICTION MARKET META ──
    { title: "Manifold accuracy 2024", domain: "prediction_market", question: "Will Manifold Markets correctly call >65% of major resolved markets in 2024?", forecastProb: 0.61, outcome: "yes", daysAgo: 185, observed: ["Manifold 2023 accuracy ~68%", "Crowd aggregation robust on high-volume markets"], inferred: ["Liquid markets with many forecasters historically well-calibrated"], speculation: ["Thin market manipulation possible on low-volume questions"] },
    { title: "Polymarket above 100M monthly volume", domain: "prediction_market", question: "Will Polymarket exceed $100M monthly trading volume in at least one month of H1 2024?", forecastProb: 0.52, outcome: "yes", daysAgo: 175, observed: ["Election cycle drives prediction market volumes", "Institutional interest rising"], inferred: ["Volume typically spikes 3-6x during major election markets"], speculation: ["Regulatory action could suppress volumes unexpectedly"] },
    { title: "Kalshi accuracy rate Q3 2024", domain: "prediction_market", question: "Will Kalshi-listed economic event contracts resolve with >60% directional accuracy vs consensus?", forecastProb: 0.58, outcome: "yes", daysAgo: 155, observed: ["Kalshi uses CFTC-regulated settlement based on government data"], inferred: ["Regulated resolution reduces manipulation; consensus usually close"], speculation: ["Data revision risk can flip outcomes after initial resolution"] },
    { title: "Metaculus community beats superforecasters", domain: "prediction_market", question: "Will Metaculus community track better than individual superforecasters on geopolitical questions in 2024?", forecastProb: 0.44, outcome: "no", daysAgo: 140, observed: ["Superforecaster literature shows individual skill is real and persistent"], inferred: ["Community aggregation helps on some domains but superforecasters dominate geopolitics"], speculation: ["Sample selection in Metaculus community may include many superforecasters"] },
    { title: "Prediction market regulated US 2024", domain: "prediction_market", question: "Will at least one US prediction market receive full CFTC trading approval in 2024?", forecastProb: 0.47, outcome: "no", daysAgo: 120, observed: ["CFTC challenged Kalshi political event contracts", "Court ruling pending"], inferred: ["Regulatory uncertainty delays expansion"], speculation: ["Pro-market Trump administration could accelerate approvals in 2025"] },
    { title: "Prediction markets beat polls 2024 election", domain: "prediction_market", question: "Will prediction market probabilities outperform polling aggregates in calling the 2024 US election?", forecastProb: 0.63, outcome: "yes", daysAgo: 105, observed: ["Polymarket moved to Trump >60% earlier than polling"], inferred: ["Markets incorporate private information and adjust faster"], speculation: ["Coordinated manipulation could distort market signal"] },
  ];

  await db.insert(journalEntries).values(
    entries.map((e) => ({
      title: e.title,
      domain: e.domain,
      question: e.question,
      forecastProb: e.forecastProb,
      horizonDays: 90,
      observed: e.observed,
      inferred: e.inferred,
      speculation: e.speculation,
      unknowns: ["Unknown unknowns remain"],
      outcome: e.outcome,
      outcomeProb: e.outcome === "yes" ? 1 : 0,
      createdAt: d(e.daysAgo),
    })),
  );
}
