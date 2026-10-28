// ─────────────────────────────────────────────
// KAMAI — Single source of truth for all verified data
// Every value has a source. Never change without updating the comment.
// ─────────────────────────────────────────────

// Change to your Render URL after deployment
export const API_BASE_URL = 'http://172.20.10.2:3001'

// Source: Fairwork India 2024, Appendix II — State Labour Dept notifications
export const MIN_WAGE_HOURLY: Record<string, number> = {
  bengaluru: 78.19,
  delhi: 92.75,
  chennai: 66.59,
  kochi: 63.79,
  thiruvananthapuram: 67.04,
}

export const CITY_LABELS: Record<string, string> = {
  bengaluru: 'Bengaluru',
  delhi: 'Delhi',
  chennai: 'Chennai',
  kochi: 'Kochi',
  thiruvananthapuram: 'Thiruvananthapuram',
}

// Source: Fairwork India Ratings 2024, page 16–17
export const FAIRWORK_SCORES: Record<string, {
  score: number
  fairPay: boolean
  fairConditions: boolean
  year: number
}> = {
  zepto: {
    score: 4,
    fairPay: false,
    fairConditions: false,
    year: 2024,
  },
  blinkit: {
    score: 6,
    fairPay: false,
    fairConditions: true,
    year: 2024,
  },
  instamart: {
    score: 6,
    fairPay: false,
    fairConditions: true,
    year: 2024,
  },
}

// Source: CBDT — GST on commission amount (not gross)
export const GST_ON_COMMISSION = 0.18

// Source: Income Tax Act Section 194C
export const TDS_RATE_WITH_PAN = 0.01
export const TDS_RATE_WITHOUT_PAN = 0.02
export const TDS_QUARTERLY_THRESHOLD = 30000

// Source: NITI Aayog June 2022
export const GIG_ECONOMY_STATS = {
  workersIn2021: 7700000,
  projectedBy2030: 23500000,
}

// Source: Scarcity scoring algorithm (Part 4 of gameplan)
export const BASELINE_RIDERS = 8
export const SCARCITY_HOT = 5
export const SCARCITY_WARM = 2

// Source: Platform partner onboarding pages — verify weekly
export const PLATFORM_DATA: Record<string, {
  label: string
  commissionMin: number
  commissionMax: number
  appFeeMin: number
  appFeeMax: number
  color: string
  accentColor: string
}> = {
  zepto: {
    label: 'Zepto',
    commissionMin: 18,
    commissionMax: 22,
    appFeeMin: 150,
    appFeeMax: 175,
    color: '#8B5CF6',
    accentColor: '#EDE9FE',
  },
  blinkit: {
    label: 'Blinkit',
    commissionMin: 20,
    commissionMax: 25,
    appFeeMin: 175,
    appFeeMax: 200,
    color: '#F59E0B',
    accentColor: '#FEF3C7',
  },
  instamart: {
    label: 'Swiggy Instamart',
    commissionMin: 22,
    commissionMax: 26,
    appFeeMin: 150,
    appFeeMax: 200,
    color: '#F97316',
    accentColor: '#FFEDD5',
  },
}

// ─────────────────────────────────────────────
// CORE EARNINGS CALCULATION
// This is the heart of Kamai. Every formula is from law.
// ─────────────────────────────────────────────
export function calculateEarnings(input: {
  gross: number
  bonus: number
  commissionPct: number   // e.g. 20 for 20%
  appFee: number
  fuel: number
  hours: number
  orders: number
  hasPan: boolean
  quarterlyGross: number  // total earned this quarter from this platform
}) {
  const {
    gross, bonus, commissionPct, appFee,
    fuel, hours, orders, hasPan, quarterlyGross
  } = input

  const totalGross = gross + bonus

  // Platform commission
  const commission = totalGross * (commissionPct / 100)

  // GST on commission — CBDT law
  const gstOnCommission = commission * GST_ON_COMMISSION

  // TDS — Income Tax Act Section 194C
  // Only applies if quarterly gross exceeds threshold
  const tdsApplies = quarterlyGross > TDS_QUARTERLY_THRESHOLD
  const tdsRate = hasPan ? TDS_RATE_WITH_PAN : TDS_RATE_WITHOUT_PAN
  const tds = tdsApplies ? totalGross * tdsRate : 0

  // Net from platform (what hits UPI)
  const netFromPlatform = totalGross - commission - gstOnCommission - tds - appFee

  // True take-home (after rider's own fuel cost)
  const trueTakeHome = netFromPlatform - fuel

  // Effective hourly rate
  const effectiveHourlyRate = hours > 0 ? trueTakeHome / hours : 0

  // Per-order average
  const perOrder = orders > 0 ? trueTakeHome / orders : 0

  // Platform tax rate (what percentage the platform takes total)
  const platformTaxRate = totalGross > 0
    ? ((commission + gstOnCommission + tds + appFee) / totalGross) * 100
    : 0

  // Annual projection
  const annualProjection = trueTakeHome * 52

  return {
    totalGross,
    commission,
    gstOnCommission,
    tds,
    tdsApplies,
    appFee,
    netFromPlatform,
    fuel,
    trueTakeHome,
    effectiveHourlyRate,
    perOrder,
    platformTaxRate,
    annualProjection,
  }
}