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

if (!entries.length) {
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

    let created = 0

    for (const entry of entries) {

      // 🔎 Verificar duplicado por UUID
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
              [[["x_epicollect_uuid", "=", entry.ec5_uuid]]],
              { limit: 1 },
            ],
          },
          id: 2,
        }),
      })

      const checkData = await checkRes.json()

      if (checkData.result.length > 0) continue

      // 🧠 Crear Lead
      await fetch(`${ODOO_URL}/jsonrpc`, {
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
              [{
                name: `Lead - ${entry["1_Nombre"]}`,
                contact_name: entry["1_Nombre"],
                phone: entry["2_Telefono"],
                description: entry["3_Descripcion"],
                email_from: entry["5_EmailVendedor"],
                x_epicollect_uuid: entry.ec5_uuid,
              }],
            ],
          },
          id: 3,
        }),
      })

      created++
    }

    return NextResponse.json({
      success: true,
      totalProcesados: entries.length,
      creados: created,
    })

  } catch (error: any) {
    return NextResponse.json(
      { error: "Error interno", detail: error.message },
      { status: 500 }
    )
  }
}