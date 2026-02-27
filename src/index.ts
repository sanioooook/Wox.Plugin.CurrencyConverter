import { Plugin, Context, Query, Result, PluginInitParams, PublicAPI } from "@wox-launcher/wox-plugin"

let api: PublicAPI

const API_BASE_URL = "https://v6.exchangerate-api.com/v6"
const DEFAULT_FAVORITE_CURRENCIES = "USD,EUR"

function isCurrencyCode(str: string): boolean {
  return str.length === 3
}

function isNumeric(str: string): boolean {
  return !isNaN(parseFloat(str)) && isFinite(Number(str))
}

interface ParseResult {
  isValid: boolean
  amount: string | null
  baseCurrency: string | null
  targetCurrencies: string[]
}

function parseQuery(search: string): ParseResult {
  const result: ParseResult = {
    isValid: false,
    amount: null,
    baseCurrency: null,
    targetCurrencies: []
  }

  const terms = search.trim().split(/\s+/).filter(t => t.length > 0)

  // valid term counts: 2, 3, or 4
  if (![2, 3, 4].includes(terms.length)) return result

  let hasToTerm = false
  let isValid = true
  let isQueryCompleted = false

  for (const term of terms) {
    if (isNumeric(term)) {
      if (result.amount === null) {
        result.amount = term
        continue
      }
      isValid = false
      break
    }

    if (term.toLowerCase() === "to") {
      hasToTerm = true
      isQueryCompleted = false
      continue
    }

    const currencyCode = term.toUpperCase()

    if (result.baseCurrency === null) {
      if (!isCurrencyCode(currencyCode)) {
        isValid = false
        break
      }
      result.baseCurrency = currencyCode
      isQueryCompleted = true
    } else {
      if (!hasToTerm) {
        isValid = false
        break
      }

      const codes = currencyCode.split(",").filter(c => isCurrencyCode(c.trim()))
      for (const code of codes) {
        const trimmed = code.trim()
        if (!result.targetCurrencies.includes(trimmed)) {
          result.targetCurrencies.push(trimmed)
        }
      }

      hasToTerm = false
      isQueryCompleted = result.targetCurrencies.length > 0
    }
  }

  // invalid if: parse failed, not completed, no base, or converting to same currency
  if (
    !isValid ||
    !isQueryCompleted ||
    result.baseCurrency === null ||
    (result.amount === null && result.targetCurrencies.length === 0) ||
    (result.targetCurrencies.length === 1 && result.baseCurrency === result.targetCurrencies[0])
  ) {
    return result
  }

  result.isValid = true
  return result
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function getPairRate(apiKey: string, from: string, to: string, amount: string): Promise<number | null> {
  try {
    const url = `${API_BASE_URL}/${apiKey}/pair/${from}/${to}/${amount}`
    const data = await fetchJson(url) as { result: string; conversion_rate: number; "error-type"?: string }
    if (data.result !== "success") return null
    return data.conversion_rate
  } catch {
    return null
  }
}

async function getAllRates(apiKey: string, from: string): Promise<Record<string, number> | null> {
  try {
    const url = `${API_BASE_URL}/${apiKey}/latest/${from}`
    const data = await fetchJson(url) as { result: string; conversion_rates: Record<string, number>; "error-type"?: string }
    if (data.result !== "success") return null
    return data.conversion_rates
  } catch {
    return null
  }
}

function makeResult(ctx: Context, title: string, subtitle: string, copyText: string): Result {
  return {
    Title: title,
    SubTitle: subtitle,
    Icon: { ImageType: "relative", ImageData: "images/app.png" },
    Score: 100,
    Actions: [
      {
        Name: "Copy result",
        IsDefault: true,
        Action: async () => {
          await api.Copy(ctx, { type: "text", text: copyText })
        }
      }
    ]
  }
}

function makeErrorResult(title: string): Result {
  return {
    Title: title,
    Icon: { ImageType: "relative", ImageData: "images/app.png" },
    Score: 100,
    Actions: []
  }
}

export const plugin: Plugin = {
  init: async (ctx: Context, params: PluginInitParams): Promise<void> => {
    api = params.API
    await api.Log(ctx, "Info", "CurrencyConverter initialized")
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const search = query.Search?.trim() ?? ""
    if (search === "") return []

    const parsed = parseQuery(search)
    if (!parsed.isValid || parsed.baseCurrency === null) return []

    const apiKey = await api.GetSetting(ctx, "apiKey")
    if (!apiKey || apiKey.trim() === "") {
      return [makeErrorResult("Currency Converter: please set your API key in plugin settings")]
    }

    const favoriteSetting = await api.GetSetting(ctx, "favoriteCurrencies")
    const favoriteRaw = favoriteSetting && favoriteSetting.trim() !== "" ? favoriteSetting : DEFAULT_FAVORITE_CURRENCIES

    let targetCurrencies = [...parsed.targetCurrencies]
    if (targetCurrencies.length === 0) {
      targetCurrencies = favoriteRaw
        .split(",")
        .map(c => c.trim().toUpperCase())
        .filter(c => isCurrencyCode(c))
    }

    // remove base currency from targets
    targetCurrencies = targetCurrencies.filter(c => c !== parsed.baseCurrency)
    if (targetCurrencies.length === 0) return []

    // if amount not specified (e.g. "USD to EUR") treat as 1
    const amountStr = parsed.amount ?? "1"
    const amount = parseFloat(amountStr)

    let rates: Record<string, number> | null = null

    if (targetCurrencies.length === 1) {
      const rate = await getPairRate(apiKey, parsed.baseCurrency, targetCurrencies[0], amountStr)
      if (rate !== null) {
        rates = { [targetCurrencies[0]]: rate }
      }
    } else {
      const allRates = await getAllRates(apiKey, parsed.baseCurrency)
      if (allRates !== null) {
        rates = {}
        for (const target of targetCurrencies) {
          if (allRates[target] !== undefined) {
            rates[target] = allRates[target]
          }
        }
      }
    }

    if (rates === null || Object.keys(rates).length === 0) {
      return [makeErrorResult("Currency Converter: failed to fetch exchange rates. Check your API key.")]
    }

    const results: Result[] = []

    for (const target of targetCurrencies) {
      const rate = rates[target]
      if (rate === undefined) continue

      const exchangeResult = amount * rate
      const exchangeResultStr = exchangeResult.toFixed(4).replace(/\.?0+$/, "")
      const inverseRate = (1 / rate).toFixed(4).replace(/\.?0+$/, "")

      const title = `${amountStr} ${parsed.baseCurrency} = ${exchangeResultStr} ${target}`
      const subtitle = `1 ${target} = ${inverseRate} ${parsed.baseCurrency}. Press Enter to copy`

      results.push(makeResult(ctx, title, subtitle, exchangeResultStr))
    }

    return results
  }
}
