
const io = require("socket.io-client");
require('dotenv').config();
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

// --- Supabase setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);


if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_KEY must be set in .env file");
}

// --- Connect to the WebSocket ---
const socket = io.connect("https://virtualfactory.online:3000");

socket.on("connect", () => {
  console.log("Connected to virtualfactory.online WebSocket");
});

socket.on("update", async (data) => {
  console.log("Received update:", data);


  try {
    // Parse idx, id, and timestamp from the root
    const recordId = data.id || uuidv4();
    const idx = data.idx || Math.floor(Math.random() * 100000);
    const recordTimestamp = data.timestamp ? new Date(data.timestamp) : new Date();

    await supabase.from("data_records").insert([
      {
        id: recordId,
        idx,
        timestamp: recordTimestamp,
      },
    ]);


    // Use the incoming data object directly as payload
    let payload = data;

    // --- Enterprise Level ---
    if (payload.Enterprise) {
    const { data: insertedEnterprise, error: enterpriseError } = await supabase
        .from("enterprise")
        .insert([
        {
            name: payload.Enterprise.name || "Enterprise",
            timestamp: payload.Enterprise.timestamp ? new Date(payload.Enterprise.timestamp) : null,
        },
        ])
        .select("id")
        .single();
    if (enterpriseError) throw new Error(`Failed to insert into enterprise: ${enterpriseError.message}`);
    const enterpriseId = insertedEnterprise.id;

    // PICS data
    if (payload.Enterprise.PICS) {
        for (const devicePath in payload.Enterprise.PICS) {
        const deviceObj = payload.Enterprise.PICS[devicePath] || {};
        for (const subDevice in deviceObj) {
            const subObj = deviceObj[subDevice] || {};
            for (const levelKey in subObj) {
            const levelObj = subObj[levelKey] || {};
            await supabase.from("pics_data").insert([
                {
                record_id: recordId,
                device_path: `${devicePath}/${subDevice}/${levelKey}`,
                device_type: subDevice,
                value: typeof levelObj.value === "object" ? JSON.stringify(levelObj.value) : levelObj.value,
                timestamp: levelObj.timestamp ? new Date(levelObj.timestamp) : null,
                },
            ]);
            }
        }
        }
    }

    // IATECH data
    if (payload.Enterprise.IATECH) {
        for (const key in payload.Enterprise.IATECH) {
        const iatechObj = payload.Enterprise.IATECH[key] || {};
        await supabase.from("iatech_data").insert([
            {
            enterprise_id: enterpriseId,
            name: key,
            value: typeof iatechObj.value === "object" ? JSON.stringify(iatechObj.value) : iatechObj.value,
            timestamp: iatechObj.timestamp ? new Date(iatechObj.timestamp) : null,
            },
        ]);
        }
    }

    // Process sites (Dallas, Austin, Smithfield, Site)
    const sites = ["Dallas", "Austin", "Smithfield", "Site"];
    for (const siteKey of sites) {
        if (payload.Enterprise[siteKey]) {
        const siteObj = payload.Enterprise[siteKey] || {};

        // Insert production line
        const { data: insertedLine, error: lineError } = await supabase
            .from("production_lines")
            .insert([
            {
                enterprise_id: enterpriseId,
                record_id: recordId,
                location: siteObj.Location?.value || siteKey,
                business_unit: siteObj.BU?.value || null,
                general_manager: siteObj.GM?.value || null,
                line_name: siteKey,
            },
            ])
            .select("id")
            .single();
        if (lineError) throw new Error(`Failed to insert into production_lines: ${lineError.message}`);
        const lineId = insertedLine.id;

        // Operations Schedule
        if (siteObj.operations_schedule) {
            const schedule = siteObj.operations_schedule;
            await supabase.from("operations_schedule").insert([
            {
                line_id: lineId,
                shifts: schedule.shifts?.value || null,
                shift_name: schedule.shift_name?.value || null,
                start_time: schedule.start_time?.value || null,
                end_time: schedule.end_time?.value || null,
                days: schedule.days?.value || null,
                timestamp: schedule.timestamp ? new Date(schedule.timestamp) : null,
            },
            ]);
        }

        // Process areas (Press, Heat Treat, Assembly, Test for Smithfield, Area for Site)
        const areas = siteKey === "Smithfield" ? ["Test"] : siteKey === "Site" ? ["Area"] : ["Press", "Heat Treat", "Assembly"];
        for (const areaKey of areas) {
            if (siteObj[areaKey]) {
            const areaObj = siteObj[areaKey] || {};
            for (const lineKey in areaObj) {
                const lineObj = areaObj[lineKey] || {};
                for (const cellKey in lineObj) {
                const cellObj = lineObj[cellKey] || {};
                for (const assetKey in cellObj) {
                    const assetObj = cellObj[assetKey] || {};
                    // Insert asset
                    const { data: insertedAsset, error: assetError } = await supabase
                    .from("assets")
                    .insert([
                        {
                        record_id: recordId,
                        line_id: lineId,
                        asset_name: assetKey,
                        site: siteKey,
                        area: areaKey,
                        line: lineKey,
                        cell: cellKey,
                        },
                    ])
                    .select("id")
                    .single();
                    if (assetError) throw new Error(`Failed to insert into assets: ${assetError.message}`);
                    const assetId = insertedAsset.id;

                    // Asset edge
                    if (assetObj.edge && assetObj.edge.value) {
                    let edgeData = {};
                    try {
                        edgeData = typeof assetObj.edge.value === "string" ? JSON.parse(assetObj.edge.value) : assetObj.edge.value;
                    } catch (e) {
                        console.warn(`Failed to parse edge data for asset ${assetKey}: ${e.message}`);
                        edgeData = {};
                    }
                    await supabase.from("asset_edge_data").insert([
                        {
                        asset_id: assetId,
                        ...edgeData,
                        timestamp: assetObj.edge.timestamp ? new Date(assetObj.edge.timestamp) : null,
                        },
                    ]);
                    }

                    // Asset line
                    if (assetObj.line && assetObj.line.value) {
                    let lineData = {};
                    try {
                        lineData = typeof assetObj.line.value === "string" ? JSON.parse(assetObj.line.value) : assetObj.line.value;
                    } catch (e) {
                        console.warn(`Failed to parse line data for asset ${assetKey}: ${e.message}`);
                        lineData = {};
                    }
                    delete lineData.asset_id_ref;
                    await supabase.from("asset_line_data").insert([
                        {
                        asset_id: assetId,
                        ...lineData,
                        timestamp: assetObj.line.timestamp ? new Date(assetObj.line.timestamp) : null,
                        },
                    ]);
                    }

                    // Asset dispatch
                    if (assetObj.dispatch) {
                    for (const dispatchType in assetObj.dispatch) {
                        const dispatchObj = assetObj.dispatch[dispatchType] || {};
                        if (dispatchObj.value) {
                        let dispatchData = {};
                        try {
                            dispatchData = typeof dispatchObj.value === "string" ? JSON.parse(dispatchObj.value) : dispatchObj.value;
                        } catch (e) {
                            console.warn(`Failed to parse dispatch data for asset ${assetKey}, type ${dispatchType}: ${e.message}`);
                            dispatchData = {};
                        }
                        await supabase.from("asset_dispatch").insert([
                            {
                            asset_id: assetId,
                            ...dispatchData,
                            timestamp: dispatchObj.timestamp ? new Date(dispatchObj.timestamp) : null,
                            },
                        ]);
                        }
                    }
                    }

                    // Asset unified (KPI)
                    if (assetObj.unified && assetObj.unified.value) {
                    let unifiedData = {};
                    try {
                        unifiedData = typeof assetObj.unified.value === "string" ? JSON.parse(assetObj.unified.value) : assetObj.unified.value;
                    } catch (e) {
                        console.warn(`Failed to parse unified data for asset ${assetKey}: ${e.message}`);
                        unifiedData = {};
                    }
                    if (unifiedData.kpi) {
                        await supabase.from("asset_kpi_data").insert([
                        {
                            asset_id: assetId,
                            ...unifiedData.kpi,
                            timestamp: assetObj.unified.timestamp ? new Date(assetObj.unified.timestamp) : null,
                        },
                        ]);
                    }
                    }
                }

                // Line-level subsystems (ERP, MES, S88, Edge, 55001, Dashboard, BigQuery)
                // ERP
                if (lineObj.ERP) {
                    const erp = lineObj.ERP;
                    await supabase.from("erp_orders").insert([
                    {
                        line_id: lineId,
                        order_number: erp.OrderNumber?.value || null,
                        order_status: erp.OrderStatus?.value || null,
                        item_number: erp.ItemNumber?.value || null,
                        item_description: erp.ItemDescription?.value || null,
                        ordered_quantity: erp.OrderedQuantity?.value || null,
                        produced_quantity: erp.ProducedQuantity?.value || null,
                        remaining_quantity: erp.RemainingQuantity?.value || null,
                        available_quantity: erp.AvailableQuantity?.value || null,
                        reserved_quantity: erp.ReservedQuantity?.value || null,
                        scheduled_start_time: erp.ScheduledStartTime?.value ? new Date(erp.ScheduledStartTime.value) : null,
                        scheduled_end_time: erp.ScheduledEndTime?.value ? new Date(erp.ScheduledEndTime.value) : null,
                        actual_start_time: erp.ActualStartTime?.value ? new Date(erp.ActualStartTime.value) : null,
                        actual_end_time: erp.ActualEndTime?.value ? new Date(erp.ActualEndTime.value) : null,
                        bom: erp.BOM?.value || null,
                        location: erp.Location?.value || null,
                    },
                    ]);
                }

                // MES KPIs
                if (lineObj.MES && lineObj.MES.KPIs) {
                    const kpi = lineObj.MES.KPIs;
                    await supabase.from("mes_kpis").insert([
                    {
                        line_id: lineId,
                        oee: kpi.OEE?.value || null,
                        availability: kpi.Availability?.value || null,
                        performance: kpi.Performance?.value || null,
                        quality: kpi.Quality?.value || null,
                        teep: kpi.TEEP?.value || null,
                        mtbf: kpi.MTBF?.value || null,
                        mttr: kpi.MTTR?.value || null,
                        timestamp: kpi.OEE?.timestamp ? new Date(kpi.OEE.timestamp) : null,
                    },
                    ]);
                }

                // Quality Control
                if (lineObj.MES && lineObj.MES.Quality) {
                    const qc = lineObj.MES.Quality;
                    await supabase.from("quality_control").insert([
                    {
                        line_id: lineId,
                        order_number: qc.OrderNumber?.value || null,
                        item_number: qc.ItemNumber?.value || null,
                        inspection_result: qc.InspectionResult?.value || null,
                        rejection_reason: qc.RejectionReason?.value || null,
                        accepted_quantity: qc.AcceptedQuantity?.value || null,
                        rejection_quantity: qc.RejectionQuantity?.value || null,
                        timestamp: qc.OrderNumber?.timestamp ? new Date(qc.OrderNumber.timestamp) : null,
                    },
                    ]);
                }

                // Maintenance Records
                if (lineObj.MES && lineObj.MES.Maintenance) {
                    const m = lineObj.MES.Maintenance;
                    await supabase.from("maintenance_records").insert([
                    {
                        line_id: lineId,
                        machine_id: m.MachineID?.value || null,
                        maintenance_status: m.MaintenanceStatus?.value || null,
                        last_maintenance_date: m.LastMaintenanceDate?.value ? new Date(m.LastMaintenanceDate.value) : null,
                        next_maintenance_date: m.NextMaintenanceDate?.value ? new Date(m.NextMaintenanceDate.value) : null,
                        maintenance_history: m.MaintenanceHistory?.value || null,
                        timestamp: m.MachineID?.timestamp ? new Date(m.MachineID.timestamp) : null,
                    },
                    ]);
                }

                // S88 Batch Control
                if (lineObj.S88 && lineObj.S88.value) {
                    let s88Data = {};
                    try {
                    s88Data = typeof lineObj.S88.value === "string" ? JSON.parse(lineObj.S88.value) : lineObj.S88.value;
                    } catch (e) {
                    console.warn(`Failed to parse S88 data for line ${lineKey}: ${e.message}`);
                    s88Data = {};
                    }
                    if (s88Data.BatchControl) {
                    const eq = s88Data.BatchControl.EquipmentModule || {};
                    const cm = s88Data.BatchControl.ControlModule || {};
                    const rm = s88Data.BatchControl.RecipeManagement || {};
                    const hmi = s88Data.BatchControl.HMI || {};
                    const dc = s88Data.BatchControl.DataCollection || {};
                    const sc = s88Data.BatchControl.SafetyCompliance || {};
                    await supabase.from("s88_batch_control").insert([
                        {
                        line_id: lineId,
                        batch_mixing_tank_status: eq.BatchMixingTankStatus || null,
                        bottler_status: eq.BottlerStatus || null,
                        capper_status: eq.CapperStatus || null,
                        temperature_controller: cm.TemperatureController || null,
                        volume_control: cm.VolumeControl || null,
                        soda_recipe: rm.SodaRecipe || null,
                        production_parameters: rm.ProductionParameters || null,
                        operator_interface_status: hmi.OperatorInterfaceStatus || null,
                        process_data: dc.ProcessData || null,
                        quality_data: dc.QualityData || null,
                        safety_status: sc.SafetyStatus || null,
                        timestamp: lineObj.S88.timestamp ? new Date(lineObj.S88.timestamp) : null,
                        },
                    ]);
                    }
                }

                // Edge Process Variables
                if (lineObj.Edge) {
                    const edge = lineObj.Edge;
                    await supabase.from("edge_process_variables").insert([
                    {
                        line_id: lineId,
                        state: edge.State?.value || null,
                        waste: edge.Waste?.value || null,
                        infeed: edge.Infeed?.value || null,
                        outfeed: edge.Outfeed?.value || null,
                        spindle_speed: edge.Process?.SpindleSpeed?.value || null,
                        feed_rate: edge.Process?.FeedRate?.value || null,
                        tool_wear: edge.Process?.ToolWear?.value || null,
                        coolant_temperature: edge.Process?.CoolantTemperature?.value || null,
                        vibration: edge.Process?.Vibration?.value || null,
                        power_consumption: edge.Process?.PowerConsumption?.value || null,
                        tool_change_count: edge.Process?.ToolChangeCount?.value || null,
                        material_temperature: edge.Process?.MaterialTemperature?.value || null,
                        part_dimensions: edge.Process?.PartDimensions?.value || null,
                        surface_finish: edge.Process?.SurfaceFinish?.value || null,
                        timestamp: edge.State?.timestamp ? new Date(edge.State.timestamp) : null,
                    },
                    ]);
                }

                // ISO 55001 Data
                if (lineObj["55001"] && lineObj["55001"].value) {
                    let isoData = {};
                    try {
                    isoData = typeof lineObj["55001"].value === "string" ? JSON.parse(lineObj["55001"].value) : lineObj["55001"].value;
                    } catch (e) {
                    console.warn(`Failed to parse ISO 55001 data for line ${lineKey}: ${e.message}`);
                    isoData = {};
                    }
                    if (isoData.AssetLifecycle) {
                    await supabase.from("iso55001_data").insert([
                        {
                        line_id: lineId,
                        lifecycle_status: isoData.AssetLifecycle.Status || null,
                        maintenance_schedule: isoData.AssetLifecycle.MaintenanceSchedule ? new Date(isoData.AssetLifecycle.MaintenanceSchedule) : null,
                        risk_level: isoData.RiskManagement?.RiskLevel || null,
                        mitigation_plan: isoData.RiskManagement?.MitigationPlan || null,
                        oee: isoData.PerformanceIndicators?.OEE || null,
                        mtbf: isoData.PerformanceIndicators?.MTBF || null,
                        mttr: isoData.PerformanceIndicators?.MTTR || null,
                        regulatory_status: isoData.Compliance?.RegulatoryStatus || null,
                        last_review_date: isoData.ContinuousImprovement?.LastReviewDate ? new Date(isoData.ContinuousImprovement.LastReviewDate) : null,
                        planned_action: isoData.ContinuousImprovement?.PlannedAction || null,
                        timestamp: lineObj["55001"].timestamp ? new Date(lineObj["55001"].timestamp) : null,
                        },
                    ]);
                    }
                }

                // Dashboard Metrics
                if (lineObj.Dashboard && lineObj.Dashboard.value) {
                    let dashData = {};
                    try {
                    dashData = typeof lineObj.Dashboard.value === "string" ? JSON.parse(lineObj.Dashboard.value) : lineObj.Dashboard.value;
                    } catch (e) {
                    console.warn(`Failed to parse Dashboard data for line ${lineKey}: ${e.message}`);
                    dashData = {};
                    }
                    await supabase.from("dashboard_metrics").insert([
                    {
                        line_id: lineId,
                        oee: dashData.OEE || null,
                        availability: dashData.Availability || null,
                        performance: dashData.Performance || null,
                        quality: dashData.Quality || null,
                        current_batch_status: dashData.CurrentBatchStatus || null,
                        maintenance_status: dashData.MaintenanceStatus || null,
                        timestamp: lineObj.Dashboard.timestamp ? new Date(lineObj.Dashboard.timestamp) : null,
                    },
                    ]);
                }

                // BigQuery Data
                if (lineObj.BigQuery && lineObj.BigQuery.value) {
                    let bigQueryData = {};
                    try {
                    bigQueryData = typeof lineObj.BigQuery.value === "string" ? JSON.parse(lineObj.BigQuery.value) : lineObj.BigQuery.value;
                    } catch (e) {
                    console.warn(`Failed to parse BigQuery data for line ${lineKey}: ${e.message}`);
                    bigQueryData = {};
                    }
                    const { data: insertedBigQuery, error: bigQueryError } = await supabase
                    .from("bigquery")
                    .insert([
                        {
                        line_id: lineId,
                        production_line: bigQueryData.production_line || lineKey,
                        timestamp: lineObj.BigQuery.timestamp ? new Date(lineObj.BigQuery.timestamp) : null,
                        },
                    ])
                    .select("id")
                    .single();
                    if (bigQueryError) throw new Error(`Failed to insert into bigquery: ${bigQueryError.message}`);
                    const bigQueryId = insertedBigQuery.id;

                    // BigQuery KPIs
                    if (bigQueryData.KPIs) {
                    await supabase.from("bigquery_kpis").insert([
                        {
                        bigquery_id: bigQueryId,
                        availability: bigQueryData.KPIs.availability || null,
                        quality: bigQueryData.KPIs.quality || null,
                        performance: bigQueryData.KPIs.performance || null,
                        oee: bigQueryData.KPIs.oee || null,
                        teep: bigQueryData.KPIs.teep || null,
                        mttr: bigQueryData.KPIs.mttr || null,
                        mtbf: bigQueryData.KPIs.mtbf || null,
                        timestamp: bigQueryData.KPIs.timestamp ? new Date(bigQueryData.KPIs.timestamp) : null,
                        },
                    ]);
                    }

                    // BigQuery ERP
                    if (bigQueryData.ERP) {
                    await supabase.from("bigquery_erp").insert([
                        {
                        bigquery_id: bigQueryId,
                        order_number: bigQueryData.ERP.order_number || null,
                        order_status: bigQueryData.ERP.order_status || null,
                        scheduled_start_time: bigQueryData.ERP.scheduled_start_time ? new Date(bigQueryData.ERP.scheduled_start_time) : null,
                        scheduled_end_time: bigQueryData.ERP.scheduled_end_time ? new Date(bigQueryData.ERP.scheduled_end_time) : null,
                        actual_start_time: bigQueryData.ERP.actual_start_time ? new Date(bigQueryData.ERP.actual_start_time) : null,
                        actual_end_time: bigQueryData.ERP.actual_end_time ? new Date(bigQueryData.ERP.actual_end_time) : null,
                        produced_quantity: bigQueryData.ERP.produced_quantity || null,
                        remaining_quantity: bigQueryData.ERP.remaining_quantity || null,
                        item_number: bigQueryData.ERP.item_number || null,
                        bom: bigQueryData.ERP.bom || null,
                        item_description: bigQueryData.ERP.item_description || null,
                        available_quantity: bigQueryData.ERP.available_quantity || null,
                        reserved_quantity: bigQueryData.ERP.reserved_quantity || null,
                        ordered_quantity: bigQueryData.ERP.ordered_quantity || null,
                        location: bigQueryData.ERP.location || null,
                        timestamp: bigQueryData.ERP.timestamp ? new Date(bigQueryData.ERP.timestamp) : null,
                        },
                    ]);
                    }

                    // BigQuery Quality (QMSData)
                    if (bigQueryData.QMSData) {
                    await supabase.from("bigquery_quality").insert([
                        {
                        bigquery_id: bigQueryId,
                        order_number: bigQueryData.QMSData.order_number || null,
                        item_number: bigQueryData.QMSData.item_number || null,
                        inspection_result: bigQueryData.QMSData.inspection_result || null,
                        rejection_reason: bigQueryData.QMSData.rejection_reason || null,
                        rejection_quantity: bigQueryData.QMSData.rejection_quantity || null,
                        accepted_quantity: bigQueryData.QMSData.accepted_quantity || null,
                        timestamp: bigQueryData.QMSData.timestamp ? new Date(bigQueryData.QMSData.timestamp) : null,
                        },
                    ]);
                    }

                    // BigQuery Maintenance (CMMSData)
                    if (bigQueryData.CMMSData) {
                    await supabase.from("bigquery_maintenance").insert([
                        {
                        bigquery_id: bigQueryId,
                        machine_id: bigQueryData.CMMSData.machine_id || null,
                        maintenance_status: bigQueryData.CMMSData.maintenance_status || null,
                        last_maintenance_date: bigQueryData.CMMSData.last_maintenance_date ? new Date(bigQueryData.CMMSData.last_maintenance_date) : null,
                        next_maintenance_date: bigQueryData.CMMSData.next_maintenance_date ? new Date(bigQueryData.CMMSData.next_maintenance_date) : null,
                        maintenance_history: bigQueryData.CMMSData.maintenance_history || null,
                        timestamp: bigQueryData.CMMSData.timestamp ? new Date(bigQueryData.CMMSData.timestamp) : null,
                        },
                    ]);
                    }

                    // BigQuery Process Variables
                    if (bigQueryData.ProcessVariables) {
                    await supabase.from("bigquery_process_variables").insert([
                        {
                        bigquery_id: bigQueryId,
                        spindle_speed: bigQueryData.ProcessVariables.spindle_speed || null,
                        feed_rate: bigQueryData.ProcessVariables.feed_rate || null,
                        tool_wear: bigQueryData.ProcessVariables.tool_wear || null,
                        coolant_temperature: bigQueryData.ProcessVariables.coolant_temperature || null,
                        vibration: bigQueryData.ProcessVariables.vibration || null,
                        power_consumption: bigQueryData.ProcessVariables.power_consumption || null,
                        tool_change_count: bigQueryData.ProcessVariables.tool_change_count || null,
                        material_temperature: bigQueryData.ProcessVariables.material_temperature || null,
                        part_dimensions: bigQueryData.ProcessVariables.part_dimensions || null,
                        surface_finish: bigQueryData.ProcessVariables.surface_finish || null,
                        timestamp: bigQueryData.ProcessVariables.timestamp ? new Date(bigQueryData.ProcessVariables.timestamp) : null,
                        },
                    ]);
                    }

                    // BigQuery ISO55001
                    if (bigQueryData.ISO55001) {
                    await supabase.from("bigquery_iso55001").insert([
                        {
                        bigquery_id: bigQueryId,
                        lifecycle_status: bigQueryData.ISO55001.lifecycle_status || null,
                        maintenance_schedule: bigQueryData.ISO55001.maintenance_schedule ? new Date(bigQueryData.ISO55001.maintenance_schedule) : null,
                        risk_level: bigQueryData.ISO55001.risk_level || null,
                        mitigation_plan: bigQueryData.ISO55001.mitigation_plan || null,
                        oee: bigQueryData.ISO55001.oee || null,
                        mtbf: bigQueryData.ISO55001.mtbf || null,
                        mttr: bigQueryData.ISO55001.mttr || null,
                        regulatory_status: bigQueryData.ISO55001.regulatory_status || null,
                        last_review_date: bigQueryData.ISO55001.last_review_date ? new Date(bigQueryData.ISO55001.last_review_date) : null,
                        planned_action: bigQueryData.ISO55001.planned_action || null,
                        timestamp: bigQueryData.ISO55001.timestamp ? new Date(bigQueryData.ISO55001.timestamp) : null,
                        },
                    ]);
                    }

                    // BigQuery S88
                    if (bigQueryData.S88) {
                    await supabase.from("bigquery_s88").insert([
                        {
                        bigquery_id: bigQueryId,
                        batch_mixing_tank_status: bigQueryData.S88.batch_mixing_tank_status || null,
                        bottler_status: bigQueryData.S88.bottler_status || null,
                        capper_status: bigQueryData.S88.capper_status || null,
                        temperature_controller: bigQueryData.S88.temperature_controller || null,
                        volume_control: bigQueryData.S88.volume_control || null,
                        soda_recipe: bigQueryData.S88.soda_recipe || null,
                        production_parameters: bigQueryData.S88.production_parameters || null,
                        operator_interface_status: bigQueryData.S88.operator_interface_status || null,
                        process_data: bigQueryData.S88.process_data || null,
                        quality_data: bigQueryData.S88.quality_data || null,
                        safety_status: bigQueryData.S88.safety_status || null,
                        timestamp: bigQueryData.S88.timestamp ? new Date(bigQueryData.S88.timestamp) : null,
                        },
                    ]);
                    }
                }
                }
            }
            }
        }
        }
    }
    }

    console.log("✅ Inserted one full update cycle into Supabase");
  } catch (err) {
    console.error("❌ Error inserting data:", err);
  }
});

socket.on("disconnect", () => {
  console.log("Disconnected from WebSocket");
});
