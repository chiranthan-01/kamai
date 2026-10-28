import { supabase } from './supabase'

export interface EarningReportInput {
  clientRecordId: string
  platform: 'zepto' | 'blinkit' | 'instamart'
  periodStart: string
  hours: number
  orders: number
  gross: number
  bonus: number
  commission: number
  gstOnCommission: number
  tds: number
  platformFees: number
  fuelCost: number
  workSlots?: Array<'morning' | 'afternoon' | 'evening' | 'night'>
  hasPan: boolean
  quarterlyGross: number
}

export interface RemoteEarningEntry {
  id: string
  platform: 'zepto' | 'blinkit' | 'instamart'
  week_start: string
  gross: number
  orders: number
  hours: number
  bonus: number
  app_fee: number
  fuel: number
  commission_pct: number
  has_pan: boolean
  quarterly_gross: number
  commission: number
  gst_on_commission: number
  tds: number
  tds_applies: boolean
  net_from_platform: number
  true_take_home: number
  effective_rate: number
  per_order: number
  platform_tax_rate: number
  annual_projection: number
  slots: Array<'morning' | 'afternoon' | 'evening' | 'night'>
  synced: true
  created_at: string
}

function addDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

export async function syncEarningReport(report: EarningReportInput): Promise<string> {
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError) throw userError
  if (!user) throw new Error('You must be logged in to sync earnings.')

  const { data: platform, error: platformError } = await supabase
    .from('platforms')
    .select('id')
    .eq('code', report.platform)
    .single()

  if (platformError) throw platformError

  const { data, error } = await supabase
    .from('earning_reports')
    .upsert(
      {
        rider_id: user.id,
        platform_id: platform.id,
        client_record_id: report.clientRecordId,
        period_start: report.periodStart,
        period_end: addDays(report.periodStart, 6),
        reported_hours: report.hours,
        orders_completed: report.orders,
        base_earnings: report.gross,
        bonus_pay: report.bonus,
        commission: report.commission,
        gst_on_commission: report.gstOnCommission,
        tds: report.tds,
        platform_fees: report.platformFees,
        fuel_cost: report.fuelCost,
        reported_work_slots: report.workSlots ?? [],
        has_pan: report.hasPan,
        reported_quarterly_gross: report.quarterlyGross,
        source: 'rider_entry',
        verification_status: 'rider_confirmed',
        source_confidence: 0.7,
      },
      { onConflict: 'rider_id,client_record_id' },
    )
    .select('id')
    .single()

  if (error) throw error
  return data.id
}

export async function fetchEarningReports(): Promise<RemoteEarningEntry[]> {
  const { data, error } = await supabase
    .from('earning_reports')
    .select(`
      client_record_id,
      period_start,
      reported_hours,
      orders_completed,
      base_earnings,
      bonus_pay,
      commission,
      gst_on_commission,
      tds,
      platform_fees,
      fuel_cost,
      gross_income,
      platform_deductions,
      net_earnings,
      reported_work_slots,
      has_pan,
      reported_quarterly_gross,
      created_at,
      platforms!inner(code)
    `)
    .order('created_at', { ascending: false })

  if (error) throw error

  return (data ?? []).map((raw: any) => {
    const grossIncome = Number(raw.gross_income)
    const deductions = Number(raw.platform_deductions)
    const netEarnings = Number(raw.net_earnings)
    const hours = Number(raw.reported_hours)
    const orders = Number(raw.orders_completed)
    const baseEarnings = Number(raw.base_earnings)
    const commission = Number(raw.commission)

    return {
      id: raw.client_record_id,
      platform: raw.platforms.code,
      week_start: raw.period_start,
      gross: baseEarnings,
      orders,
      hours,
      bonus: Number(raw.bonus_pay),
      app_fee: Number(raw.platform_fees),
      fuel: Number(raw.fuel_cost),
      commission_pct: baseEarnings > 0 ? (commission / baseEarnings) * 100 : 0,
      // Existing pre-column reports came from the calculator, which used PAN=true.
      has_pan: raw.has_pan ?? true,
      quarterly_gross: Number(raw.reported_quarterly_gross ?? 0),
      commission,
      gst_on_commission: Number(raw.gst_on_commission),
      tds: Number(raw.tds),
      tds_applies: Number(raw.tds) > 0,
      net_from_platform: grossIncome - deductions,
      true_take_home: netEarnings,
      effective_rate: hours > 0 ? netEarnings / hours : 0,
      per_order: orders > 0 ? netEarnings / orders : 0,
      platform_tax_rate: grossIncome > 0 ? (deductions / grossIncome) * 100 : 0,
      annual_projection: netEarnings * 52,
      slots: raw.reported_work_slots ?? [],
      synced: true as const,
      created_at: raw.created_at,
    }
  })
}
