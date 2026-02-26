import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "API funcionando correctamente" });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const {
      nombre,
      telefono,
      descripcion,
      latitude,
      longitude,
      vendedor_email,
    } = body;

    if (!nombre || !telefono || !descripcion) {
      return NextResponse.json(
        { error: "Faltan campos obligatorios" },
        { status: 400 }
      );
    }

    const ODOO_URL = process.env.ODOO_URL!;
    const ODOO_DB = process.env.ODOO_DB!;
    const ODOO_USERNAME = process.env.ODOO_USERNAME!;
    const ODOO_PASSWORD = process.env.ODOO_PASSWORD!;

    if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_PASSWORD) {
      return NextResponse.json(
        { error: "Variables de entorno no configuradas" },
        { status: 500 }
      );
    }

    // =============================
    // 1️⃣ Autenticación en Odoo
    // =============================

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
    });

    const authData = await authRes.json();
    const uid = authData.result;

    if (!uid) {
      return NextResponse.json(
        { error: "Error autenticando en Odoo" },
        { status: 401 }
      );
    }

    // =============================
    // 2️⃣ Buscar vendedor por email
    // =============================

    let vendedorId = false;

    if (vendedor_email) {
      const userRes = await fetch(`${ODOO_URL}/jsonrpc`, {
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
              [[["login", "=", vendedor_email]]],
              { fields: ["id"], limit: 1 },
            ],
          },
          id: 2,
        }),
      });

      const userData = await userRes.json();

      if (userData.result && userData.result.length > 0) {
        vendedorId = userData.result[0].id;
      }
    }

    // =============================
    // 3️⃣ Crear Lead en Odoo
    // =============================

    const leadRes = await fetch(`${ODOO_URL}/jsonrpc`, {
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
            [
              {
                name: `Lead - ${nombre}`,
                contact_name: nombre,
                phone: telefono,
                description: `
DETALLES:
${descripcion}

UBICACIÓN:
Lat: ${latitude ?? "No enviada"}
Lng: ${longitude ?? "No enviada"}

VENDEDOR:
${vendedor_email ?? "No identificado"}
                `,
                user_id: vendedorId || false,
              },
            ],
          ],
        },
        id: 3,
      }),
    });

    const leadData = await leadRes.json();

    if (!leadData.result) {
      return NextResponse.json(
        { error: "Error creando lead", detail: leadData },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      leadId: leadData.result,
      vendedorAsignado: vendedorId || "Sin asignar",
    });

  } catch (error: any) {
    console.error("Error general:", error);
    return NextResponse.json(
      { error: "Error interno del servidor", detail: error.message },
      { status: 500 }
    );
  }
}