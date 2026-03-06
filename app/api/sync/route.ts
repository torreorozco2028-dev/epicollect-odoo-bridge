import { NextRequest, NextResponse } from "next/server"

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)

    // 🔐 Seguridad
    if (searchParams.get("token") !== process.env.API_SECRET) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

    // =============================
    // 1️⃣ Obtener datos de EpiCollect
    // =============================

    const epiAuth = Buffer
      .from(`${process.env.EPI_USER}:${process.env.EPI_PASS}`)
      .toString("base64")

    const now = new Date()
    const todayStartUtc = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    ))
    const todayEndUtc = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999
    ))

    const toEc5Date = (date: Date) => date.toISOString().replace("Z", "")
    const epiQuery = new URLSearchParams({
      filter_by: "created_at",
      filter_from: toEc5Date(todayStartUtc),
      filter_to: toEc5Date(todayEndUtc),
    })
    const epiUrl = `https://five.epicollect.net/api/export/entries/torreorozco2027?${epiQuery.toString()}`

    const epiRes = await fetch(
      epiUrl,
      {
        headers: { Authorization: `Basic ${epiAuth}` },
        cache: "no-store",
      }
    )

    const epiData = await epiRes.json()
    const entriesRaw = epiData && epiData.data && Array.isArray(epiData.data.entries)
      ? epiData.data.entries
      : []

    const entries = entriesRaw.filter((entry: Record<string, unknown>) => {
      const rawDate = entry?.ec5_created_at ?? entry?.created_at
      if (!rawDate || typeof rawDate !== "string") {
        return false
      }

      const entryDate = new Date(rawDate)
      if (Number.isNaN(entryDate.getTime())) {
        return false
      }

      return entryDate >= todayStartUtc && entryDate <= todayEndUtc
    })
    if (!entries || entries.length < 1) {
      return NextResponse.json({ message: "No hay registros nuevos" })
    }

    // =============================
    // 2️⃣ Autenticación en Odoo
    // =============================

    const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD } = process.env

    const authRes = await fetch(`${ODOO_URL}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: {
          service: "common",
          method: "authenticate",
          args: [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}],
        },
        id: 1,
      }),
    })

    const authData = await authRes.json()
    const uid = authData.result
 
    if (!uid) {
      return NextResponse.json({ error: "Error autenticando en Odoo" }, { status: 401 })
    }
   
    const fieldCheckRes = await fetch(`${ODOO_URL}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: {
          service: "object",
          method: "execute_kw",
          args: [
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            "crm.lead",
            "fields_get",
            [["x_epicollect_uuid"]],
            { attributes: ["type"] },
          ],
        },
        id: 10,
      }),
    })

    const fieldCheckData = await fieldCheckRes.json()
    const hasEpicollectUuidField = Boolean(
      fieldCheckData?.result && fieldCheckData.result.x_epicollect_uuid
    )
    if (!hasEpicollectUuidField) {
      return NextResponse.json(
        { error: "El campo x_epicollect_uuid no existe en crm.lead" },
        { status: 400 }
      )
    }

    let created = 0
    let duplicated = 0
    let skippedWithoutUuid = 0
    const sellerCache = new Map<string, number | null>()
    const partnerCache = new Map<string, number | null>()

    for (const entry of entries) {

      const email = entry?.["6_EmailVendedor"]
      const ec5Uuid = entry?.ec5_uuid
      if (!ec5Uuid) {
        skippedWithoutUuid++
        continue
      }

      // 🔎 Verificar duplicado solo por UUID
      const checkRes = await fetch(`${ODOO_URL}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: {
            service: "object",
            method: "execute_kw",
            args: [
              ODOO_DB,
              uid,
              ODOO_PASSWORD,
              "crm.lead",
              "search",
              [[["x_epicollect_uuid", "=", ec5Uuid]]],
              { limit: 1 },
            ],
          },
          id: 2,
        }),
      })

      const checkData = await checkRes.json()
      if (checkData?.error) {
        throw new Error(checkData.error?.data?.message || checkData.error?.message || "Error verificando duplicado en Odoo")
      }

      const duplicatedIds = Array.isArray(checkData?.result) ? checkData.result : []
      if (duplicatedIds.length > 0) {
        duplicated++
        continue
      }

      let sellerId: number | null = null
      if (email) {
        if (sellerCache.has(email)) {
          sellerId = sellerCache.get(email) ?? null
        } else {
          const sellerRes = await fetch(`${ODOO_URL}/jsonrpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "call",
              params: {
                service: "object",
                method: "execute_kw",
                args: [
                  ODOO_DB,
                  uid,
                  ODOO_PASSWORD,
                  "res.users",
                  "search_read",
                  [["|", ["login", "=", email], ["email", "=", email]]],
                  { fields: ["id", "name"], limit: 1 },
                ],
              },
              id: 20,
            }),
          })

          const sellerData = await sellerRes.json()
          if (sellerData?.error) {
            throw new Error(sellerData.error?.data?.message || sellerData.error?.message || "Error buscando vendedor en Odoo")
          }

          const sellerRows = Array.isArray(sellerData?.result) ? sellerData.result : []
          sellerId = sellerRows?.[0]?.id ?? null
          sellerCache.set(email, sellerId)
        }
      }

      const contactName = typeof entry["2_Nombre"] === "string"
        ? entry["2_Nombre"].trim()
        : ""
      const contactPhone = typeof entry["3_Telefono"] === "string"
        ? entry["3_Telefono"].trim()
        : ""

      let partnerId: number | null = null
      if (contactName && contactPhone) {
        const partnerCacheKey = `${contactName.toLowerCase()}|${contactPhone}`

        if (partnerCache.has(partnerCacheKey)) {
          partnerId = partnerCache.get(partnerCacheKey) ?? null
        } else {
          const partnerSearchRes = await fetch(`${ODOO_URL}/jsonrpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "call",
              params: {
                service: "object",
                method: "execute_kw",
                args: [
                  ODOO_DB,
                  uid,
                  ODOO_PASSWORD,
                  "res.partner",
                  "search_read",
                  [["&", ["name", "=", contactName], ["phone", "=", contactPhone]]],
                  { fields: ["id"], limit: 1 },
                ],
              },
              id: 30,
            }),
          })

          const partnerSearchData = await partnerSearchRes.json()
          if (partnerSearchData?.error) {
            throw new Error(
              partnerSearchData.error?.data?.message
              || partnerSearchData.error?.message
              || "Error buscando contacto en Odoo"
            )
          }

          const partnerRows = Array.isArray(partnerSearchData?.result)
            ? partnerSearchData.result
            : []
          partnerId = partnerRows?.[0]?.id ?? null

          if (!partnerId) {
            const partnerCreateRes = await fetch(`${ODOO_URL}/jsonrpc`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                method: "call",
                params: {
                  service: "object",
                  method: "execute_kw",
                  args: [
                    ODOO_DB,
                    uid,
                    ODOO_PASSWORD,
                    "res.partner",
                    "create",
                    [{
                      name: contactName,
                      phone: contactPhone,
                    }],
                  ],
                },
                id: 31,
              }),
            })

            const partnerCreateData = await partnerCreateRes.json()
            if (partnerCreateData?.error) {
              throw new Error(
                partnerCreateData.error?.data?.message
                || partnerCreateData.error?.message
                || "Error creando contacto en Odoo"
              )
            }

            partnerId = typeof partnerCreateData?.result === "number"
              ? partnerCreateData.result
              : null
          }

          partnerCache.set(partnerCacheKey, partnerId)
        }
      }

      // 🧠 Crear Lead
      const leadPayload: Record<string, unknown> = {
        name: `${entry["1_Titulo"]}`,
        // `2_Nombre` de EpiCollect se sincroniza con `contact_name` en crm.lead.
        contact_name: contactName,
        partner_name: contactName,
        phone: entry["3_Telefono"],
        description: entry["4_Descripcion"],
        probability: entry["5_Interes"],
      }

      if (partnerId) {
        leadPayload.partner_id = partnerId
      }

      leadPayload.x_epicollect_uuid = ec5Uuid

      if (sellerId) {
        leadPayload.user_id = sellerId
      }

      const createRes = await fetch(`${ODOO_URL}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: {
            service: "object",
            method: "execute_kw",
            args: [
              ODOO_DB,
              uid,
              ODOO_PASSWORD,
              "crm.lead",
              "create",
              [leadPayload],
            ],
          },
          id: 3,
        }),
      })

      const createData = await createRes.json()
      if (createData?.error) {
        throw new Error(createData.error?.data?.message || createData.error?.message || "Error creando lead en Odoo")
      }

      created++
    }

    return NextResponse.json({
      success: true,
      totalProcesados: entries.length,
      creados: created,
      duplicados: duplicated,
      omitidosSinUuid: skippedWithoutUuid,
    })

  } catch (error: any) {
    return NextResponse.json(
      { error: "Error interno", detail: error.message },
      { status: 500 }
    )
  }
}