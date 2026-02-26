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

    const epiRes = await fetch(
      "https://five.epicollect.net/api/export/entries/torreorozco2028",
      {
        headers: { Authorization: `Basic ${epiAuth}` },
        cache: "no-store",
      }
    )

    const epiData = await epiRes.json()
    console.log("Datos recibidos de EpiCollect:", epiData)
 const entries = epiData && epiData.data && Array.isArray(epiData.data.entries)
  ? epiData.data.entries
  : []
console.log("Entries extraídas:", entries)
if ( !entries || entries.length < 1) {
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
    console.log("Autenticación en Odoo:", authData)
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
    console.log("Verificación del campo x_epicollect_uuid en Odoo:", fieldCheckData)
    const hasEpicollectUuidField = Boolean(
      fieldCheckData?.result && fieldCheckData.result.x_epicollect_uuid
    )
    console.log("Campo x_epicollect_uuid disponible:", hasEpicollectUuidField)

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

    for (const entry of entries) {

      const email = entry?.["5_EmailVendedor"]
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
      console.log("Verificación de duplicado:", checkData)

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
          console.log("Vendedor encontrado para email:", email, sellerId)
        }
      }

      // 🧠 Crear Lead
      const leadPayload: Record<string, unknown> = {
        name: `Lead - ${entry["1_Nombre"]}`,
        contact_name: entry["1_Nombre"],
        phone: entry["2_Telefono"],
        description: entry["3_Descripcion"],
        email_from: entry["5_EmailVendedor"],
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