const io = require("socket.io-client");
require('dotenv').config();
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

// --- Supabase setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_KEY must be set in .env file");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// --- Helper Functions ---

/**
 * Safely parse JSON value
 */
function safeJsonParse(value, context = "") {
  if (typeof value === "object" && value !== null) {
    return value;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (e) {
      console.warn(`Failed to parse JSON ${context}: ${e.message}`);
      return null;
    }
  }
  return null;
}

/**
 * Convert timestamp to Date object
 */
function toDate(timestamp) {
  if (!timestamp) return null;
  try {
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) {
    return null;
  }
}

/**
 * Extract value from data object
 */
function getValue(obj, defaultValue = null) {
  if (!obj) return defaultValue;
  return obj.value !== undefined ? obj.value : defaultValue;
}

/**
 * Get or create site and return site_id
 */
async function getOrCreateSite(siteName, bu = null, gm = null) {
  try {
    // First try to find existing site
    const { data: existingSite, error: findError } = await supabase
      .from("sites")
      .select("site_id")
      .eq("site_name", siteName)
      .single();

    if (existingSite) {
      return existingSite.site_id;
    }

    // Create new site
    const { data: newSite, error: insertError } = await supabase
      .from("sites")
      .insert([{
        site_name: siteName,
        business_unit: bu,
        general_manager: gm,
      }])
      .select("site_id")
      .single();

    if (insertError) {
      console.error(`Error creating site ${siteName}:`, insertError);
      return null;
    }

    return newSite.site_id;
  } catch (error) {
    console.error(`Exception in getOrCreateSite for ${siteName}:`, error);
    return null;
  }
}

/**
 * Get or create area and return area_id
 */
async function getOrCreateArea(siteId, areaName) {
  try {
    const { data: existingArea, error: findError } = await supabase
      .from("areas")
      .select("area_id")
      .eq("site_id", siteId)
      .eq("area_name", areaName)
      .single();

    if (existingArea) {
      return existingArea.area_id;
    }

    const { data: newArea, error: insertError } = await supabase
      .from("areas")
      .insert([{
        site_id: siteId,
        area_name: areaName,
      }])
      .select("area_id")
      .single();

    if (insertError) {
      console.error(`Error creating area ${areaName}:`, insertError);
      return null;
    }

    return newArea.area_id;
  } catch (error) {
    console.error(`Exception in getOrCreateArea for ${areaName}:`, error);
    return null;
  }
}

/**
 * Get or create production line and return line_id
 */
async function getOrCreateLine(areaId, lineName) {
  try {
    const { data: existingLine, error: findError } = await supabase
      .from("production_lines")
      .select("line_id")
      .eq("area_id", areaId)
      .eq("line_name", lineName)
      .single();

    if (existingLine) {
      return existingLine.line_id;
    }

    const { data: newLine, error: insertError } = await supabase
      .from("production_lines")
      .insert([{
        area_id: areaId,
        line_name: lineName,
      }])
      .select("line_id")
      .single();

    if (insertError) {
      console.error(`Error creating line ${lineName}:`, insertError);
      return null;
    }

    return newLine.line_id;
  } catch (error) {
    console.error(`Exception in getOrCreateLine for ${lineName}:`, error);
    return null;
  }
}

/**
 * Get or create asset and return asset_id
 */
async function getOrCreateAsset(lineId, assetName, assetType = null) {
  try {
    const { data: existingAsset, error: findError } = await supabase
      .from("assets")
      .select("asset_id")
      .eq("line_id", lineId)
      .eq("asset_name", assetName)
      .single();

    if (existingAsset) {
      return existingAsset.asset_id;
    }

    const { data: newAsset, error: insertError } = await supabase
      .from("assets")
      .insert([{
        line_id: lineId,
        asset_name: assetName,
        asset_type: assetType,
      }])
      .select("asset_id")
      .single();

    if (insertError) {
      console.error(`Error creating asset ${assetName}:`, insertError);
      return null;
    }

    return newAsset.asset_id;
  } catch (error) {
    console.error(`Exception in getOrCreateAsset for ${assetName}:`, error);
    return null;
  }
}

// --- Main Processing Functions ---

/**
 * Process PICS data
 */
async function processPicsData(picsData) {
  if (!picsData) return;

  try {
    for (const devicePath in picsData) {
      const deviceObj = picsData[devicePath] || {};
      for (const subDevice in deviceObj) {
        const subObj = deviceObj[subDevice] || {};
        for (const levelKey in subObj) {
          const levelObj = subObj[levelKey] || {};
          
          await supabase.from("pics_data").insert([{
            device_path: `${devicePath}/${subDevice}/${levelKey}`,
            parameter_name: levelKey,
            value: typeof levelObj.value === "object" 
              ? JSON.stringify(levelObj.value) 
              : String(levelObj.value || ""),
            timestamp: toDate(levelObj.timestamp),
          }]);
        }
      }
    }
  } catch (error) {
    console.error("Error processing PICS data:", error);
  }
}

/**
 * Process IATECH data
 */
async function processIatechData(iatechData) {
  if (!iatechData) return;

  try {
    for (const key in iatechData) {
      const iatechObj = iatechData[key] || {};
      
      await supabase.from("iatech_data").insert([{
        parameter_name: key,
        value: typeof iatechObj.value === "object" 
          ? JSON.stringify(iatechObj.value) 
          : String(iatechObj.value || ""),
        timestamp: toDate(iatechObj.timestamp),
      }]);
    }
  } catch (error) {
    console.error("Error processing IATECH data:", error);
  }
}

/**
 * Process asset edge data
 */
async function processAssetEdge(assetId, edgeObj, timestamp) {
  if (!edgeObj || !edgeObj.value) return;

  try {
    const edgeData = safeJsonParse(edgeObj.value, "asset edge");
    if (!edgeData) return;

    await supabase.from("asset_edge_data").insert([{
      asset_id: assetId,
      state: edgeData.state || null,
      outfeed: edgeData.outfeed || null,
      waste: edgeData.waste || null,
      infeed: edgeData.infeed || null,
      total_strokes: edgeData.total_strokes || null,
      stroke_raw: edgeData.stroke_raw || null,
      waste_injected: edgeData.waste_injected || null,
      raw_json: edgeData,
      timestamp: toDate(timestamp || edgeObj.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing asset edge for asset ${assetId}:`, error);
  }
}

/**
 * Process asset line data
 */
async function processAssetLine(assetId, lineObj, timestamp) {
  if (!lineObj || !lineObj.value) return;

  try {
    const lineData = safeJsonParse(lineObj.value, "asset line");
    if (!lineData) return;

    await supabase.from("asset_line_data").insert([{
      asset_id: assetId,
      run_enable: lineData.RunEnable || null,
      outfeed: lineData.Outfeed || null,
      infeed: lineData.Infeed || null,
      scheduled_rate: lineData.Scheduled_rate || null,
      run_start_time: toDate(lineData.Run_StartTime),
      state: lineData.State || null,
      waste: lineData.Waste || null,
      runtime: lineData.runtime || null,
      run_id: lineData.Run_ID || null,
      current_production_rate: lineData.current_production_rate || null,
      raw_json: lineData,
      timestamp: toDate(timestamp || lineObj.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing asset line for asset ${assetId}:`, error);
  }
}

/**
 * Process asset unified data (KPI)
 */
async function processAssetUnified(assetId, unifiedObj, timestamp) {
  if (!unifiedObj || !unifiedObj.value) return;

  try {
    const unifiedData = safeJsonParse(unifiedObj.value, "asset unified");
    if (!unifiedData || !unifiedData.kpi) return;

    const kpi = unifiedData.kpi;
    
    await supabase.from("asset_unified_data").insert([{
      asset_id: assetId,
      availability: kpi.availability || null,
      performance: kpi.performance || null,
      quality: kpi.quality || null,
      oee: kpi.oee || null,
      run_time: kpi.runTime || null,
      total_time: kpi.totalTime || null,
      planned_downtime: kpi.plannedDowntime || null,
      unplanned_downtime: kpi.unplannedDowntime || null,
      total_strokes: kpi.totalStrokes || null,
      cycle_time: kpi.cycleTime || null,
      run_enable: unifiedData.RunEnable || null,
      outfeed: unifiedData.Outfeed || null,
      infeed: unifiedData.Infeed || null,
      scheduled_rate: unifiedData.Scheduled_rate || null,
      state: unifiedData.State || null,
      waste: unifiedData.Waste || null,
      runtime: unifiedData.runtime || null,
      run_id: unifiedData.Run_ID || null,
      current_production_rate: unifiedData.current_production_rate || null,
      raw_json: unifiedData,
      timestamp: toDate(timestamp || unifiedObj.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing asset unified for asset ${assetId}:`, error);
  }
}

/**
 * Process asset dispatch data
 */
async function processAssetDispatch(assetId, dispatchObj) {
  if (!dispatchObj) return;

  try {
    for (const dispatchType in dispatchObj) {
      const dispatchData = dispatchObj[dispatchType] || {};
      if (!dispatchData.value) continue;

      const parsed = safeJsonParse(dispatchData.value, `dispatch ${dispatchType}`);
      if (!parsed) continue;

      await supabase.from("asset_dispatch").insert([{
        asset_id: assetId,
        run_order_id: parsed.Run_Order_ID || null,
        count_type: parsed.Count_Type || null,
        count_type_name: dispatchType,
        last_count: parsed.Last_Count || null,
        count: parsed.Count || null,
        state_id: parsed.State_ID || null,
        state_runtime: parsed.State_Runtime || null,
        trigger_reason: parsed.trigger_reason || null,
        timestamp: toDate(parsed.Timestamp),
        dispatch_timestamp: toDate(dispatchData.timestamp),
      }]);
    }
  } catch (error) {
    console.error(`Error processing asset dispatch for asset ${assetId}:`, error);
  }
}

/**
 * Process operations schedule
 */
async function processOperationsSchedule(areaId, scheduleObj) {
  if (!scheduleObj || !scheduleObj.value) return;

  try {
    const schedule = safeJsonParse(scheduleObj.value, "operations schedule");
    if (!schedule) return;

    await supabase.from("operations_schedule").insert([{
      area_id: areaId,
      shifts: schedule.Shifts || null,
      shift_config: schedule.ShiftHours || null,
      timestamp: toDate(scheduleObj.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing operations schedule for area ${areaId}:`, error);
  }
}

/**
 * Process ERP orders
 */
async function processErpOrders(lineId, erpData) {
  if (!erpData) return;

  try {
    await supabase.from("erp_orders").insert([{
      line_id: lineId,
      order_number: getValue(erpData.OrderNumber),
      order_status: getValue(erpData.OrderStatus),
      item_number: getValue(erpData.ItemNumber),
      item_description: getValue(erpData.ItemDescription),
      ordered_quantity: getValue(erpData.OrderedQuantity),
      produced_quantity: getValue(erpData.ProducedQuantity),
      remaining_quantity: getValue(erpData.RemainingQuantity),
      available_quantity: getValue(erpData.AvailableQuantity),
      reserved_quantity: getValue(erpData.ReservedQuantity),
      scheduled_start_time: toDate(getValue(erpData.ScheduledStartTime || erpData.ScheduleStartTime)),
      scheduled_end_time: toDate(getValue(erpData.ScheduledEndTime || erpData.ScheduleEndTime)),
      actual_start_time: toDate(getValue(erpData.ActualStartTime)),
      actual_end_time: toDate(getValue(erpData.ActualEndTime)),
      bom: getValue(erpData.BOM),
      location: getValue(erpData.Location),
      timestamp: toDate(erpData.OrderNumber?.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing ERP orders for line ${lineId}:`, error);
  }
}

/**
 * Process MES KPIs
 */
async function processMesKpis(lineId, kpiData) {
  if (!kpiData) return;

  try {
    await supabase.from("mes_kpis").insert([{
      line_id: lineId,
      availability: getValue(kpiData.Availability),
      quality: getValue(kpiData.Quality),
      performance: getValue(kpiData.Performance),
      oee: getValue(kpiData.OEE),
      teep: getValue(kpiData.TEEP),
      mtbf: getValue(kpiData.MTBF),
      mttr: getValue(kpiData.MTTR),
      timestamp: toDate(kpiData.OEE?.timestamp || kpiData.Availability?.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing MES KPIs for line ${lineId}:`, error);
  }
}

/**
 * Process quality control
 */
async function processQualityControl(lineId, qualityData) {
  if (!qualityData) return;

  try {
    await supabase.from("quality_control").insert([{
      line_id: lineId,
      order_number: getValue(qualityData.OrderNumber),
      item_number: getValue(qualityData.ItemNumber),
      inspection_result: getValue(qualityData.InspectionResult || qualityData.InspectionResults),
      rejection_reason: getValue(qualityData.RejectionReason),
      accepted_quantity: getValue(qualityData.AcceptedQuantity),
      rejection_quantity: getValue(qualityData.RejectionQuantity),
      timestamp: toDate(qualityData.OrderNumber?.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing quality control for line ${lineId}:`, error);
  }
}

/**
 * Process maintenance records
 */
async function processMaintenanceRecords(lineId, maintenanceData) {
  if (!maintenanceData) return;

  try {
    await supabase.from("maintenance_records").insert([{
      line_id: lineId,
      machine_id: getValue(maintenanceData.MachineID),
      maintenance_status: getValue(maintenanceData.MaintenanceStatus),
      last_maintenance_date: toDate(getValue(maintenanceData.LastMaintenanceDate)),
      next_maintenance_date: toDate(getValue(maintenanceData.NextMaintenanceDate)),
      maintenance_history: getValue(maintenanceData.MaintenanceHistory),
      timestamp: toDate(maintenanceData.MachineID?.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing maintenance records for line ${lineId}:`, error);
  }
}

/**
 * Process S88 batch control
 */
async function processS88BatchControl(lineId, s88Obj) {
  if (!s88Obj || !s88Obj.value) return;

  try {
    const s88Data = safeJsonParse(s88Obj.value, "S88");
    if (!s88Data || !s88Data.BatchControl) return;

    const bc = s88Data.BatchControl;
    const eq = bc.EquipmentModule || {};
    const cm = bc.ControlModule || {};
    const rm = bc.RecipeManagement || {};
    const hmi = bc.HMI || {};
    const dc = bc.DataCollection || {};
    const sc = bc.SafetyCompliance || {};

    await supabase.from("s88_batch_control").insert([{
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
      raw_json: s88Data,
      timestamp: toDate(s88Obj.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing S88 for line ${lineId}:`, error);
  }
}

/**
 * Process edge process variables
 * Note: If your schema uses line_id instead of asset_id, this is correct.
 * If using the recommended schema with asset_id, you need to create a virtual asset for line-level edge data.
 */
async function processEdgeProcessVariables(lineId, edgeData) {
  if (!edgeData) return;

  try {
    const process = edgeData.Process || {};

    // Get timestamp from any available source
    const timestamp = toDate(
      edgeData.State?.timestamp || 
      process.SpindleSpeed?.timestamp || 
      edgeData.timestamp
    );

    await supabase.from("edge_process_variables").insert([{
      asset_id: lineId,  // CHANGED: Using asset_id as per recommended schema
      state: getValue(edgeData.State),
      waste: getValue(edgeData.Waste),
      infeed: getValue(edgeData.Infeed),
      outfeed: getValue(edgeData.Outfeed),
      spindle_speed: getValue(process.SpindleSpeed),
      feed_rate: getValue(process.FeedRate),
      tool_wear: getValue(process.ToolWear),
      vibration: getValue(process.Vibration),
      power_consumption: getValue(process.PowerConsumption),
      tool_change_count: getValue(process.ToolChangeCount),
      material_temperature: getValue(process.MaterialTemperature),
      coolant_temperature: getValue(process.CoolantTemperature),
      part_dimensions: getValue(process.PartDimensions || process.PartDimension),
      surface_finish: getValue(process.SurfaceFinish),
      timestamp: timestamp,
    }]);
  } catch (error) {
    console.error(`Error processing edge process variables for asset/line ${lineId}:`, error);
  }
}

/**
 * Process ISO 55001 data
 */
async function processIso55001Data(lineId, isoObj) {
  if (!isoObj || !isoObj.value) return;

  try {
    const isoData = safeJsonParse(isoObj.value, "ISO 55001");
    if (!isoData) return;

    const al = isoData.AssetLifecycle || {};
    const rm = isoData.RiskManagement || {};
    const pi = isoData.PerformanceIndicators || {};
    const comp = isoData.Compliance || {};
    const ci = isoData.ContinuousImprovement || {};

    await supabase.from("iso55001_data").insert([{
      line_id: lineId,
      asset_lifecycle_status: al.Status || null,
      maintenance_schedule: toDate(al.MaintenanceSchedule),
      risk_level: rm.RiskLevel || null,
      mitigation_plan: rm.MitigationPlan || null,
      oee: pi.OEE || null,
      mtbf: pi.MTBF || null,
      mttr: pi.MTTR || null,
      regulatory_status: comp.RegulatoryStatus || null,
      last_review_date: toDate(ci.LastReviewDate),
      planned_action: ci.PlannedAction || null,
      timestamp: toDate(isoObj.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing ISO 55001 for line ${lineId}:`, error);
  }
}

/**
 * Process dashboard metrics
 */
async function processDashboardMetrics(lineId, dashboardObj) {
  if (!dashboardObj || !dashboardObj.value) return;

  try {
    const dashData = safeJsonParse(dashboardObj.value, "dashboard");
    if (!dashData) return;

    await supabase.from("dashboard_metrics").insert([{
      line_id: lineId,
      oee: dashData.OEE || null,
      availability: dashData.Availability || null,
      performance: dashData.Performance || null,
      quality: dashData.Quality || null,
      current_batch_status: dashData.CurrentBatchStatus || null,
      maintenance_status: dashData.MaintenanceStatus || null,
      timestamp: toDate(dashboardObj.timestamp),
    }]);
  } catch (error) {
    console.error(`Error processing dashboard metrics for line ${lineId}:`, error);
  }
}

/**
 * Process BigQuery data and all its subsystems
 */
async function processBigQueryData(lineId, bigQueryObj) {
  if (!bigQueryObj || !bigQueryObj.value) return;

  try {
    const bqData = safeJsonParse(bigQueryObj.value, "BigQuery");
    if (!bqData) return;

    // Insert main BigQuery record
    const { data: insertedBQ, error: bqError } = await supabase
      .from("bigquery")
      .insert([{
        line_id: lineId,
        production_line: bqData.ProductionLine || "Line",
        kpi_data: bqData.KPIData || null,
        erp_data: bqData.ERPData || null,
        qms_data: bqData.QMSData || null,
        cmms_data: bqData.CMMSData || null,
        process_variables: bqData.ProcessVariables || null,
        iso55001: bqData.ISO55001 || null,
        s88: bqData.S88 || null,
        timestamp: toDate(bigQueryObj.timestamp),
      }])
      .select("bq_id")
      .single();

    if (bqError || !insertedBQ) {
      console.error("Error inserting BigQuery:", bqError);
      return;
    }

    const bqId = insertedBQ.bq_id;

    // BigQuery KPIs
    if (bqData.KPIData) {
      const kpi = bqData.KPIData;
      await supabase.from("bigquery_kpis").insert([{
        bigquery_id: bqId,
        availability: kpi.Availability || null,
        quality: kpi.Quality || null,
        performance: kpi.Performance || null,
        oee: kpi.OEE || null,
        teep: kpi.TEEP || null,
        mttr: kpi.MTTR || null,
        mtbf: kpi.MTBF || null,
        timestamp: toDate(bigQueryObj.timestamp),
      }]);
    }

    // BigQuery ERP
    if (bqData.ERPData) {
      const erp = bqData.ERPData;
      await supabase.from("bigquery_erp").insert([{
        bigquery_id: bqId,
        order_number: erp.OrderNumber || null,
        order_status: erp.OrderStatus || null,
        scheduled_start_time: toDate(erp.ScheduledStartTime),
        scheduled_end_time: toDate(erp.ScheduledEndTime),
        actual_start_time: toDate(erp.ActualStartTime),
        actual_end_time: toDate(erp.ActualEndTime),
        produced_quantity: erp.ProducedQuantity || null,
        remaining_quantity: erp.RemainingQuantity || null,
        item_number: erp.ItemNumber || null,
        bom: erp.BOM || null,
        item_description: erp.ItemDescription || null,
        available_quantity: erp.AvailableQuantity || null,
        reserved_quantity: erp.ReservedQuantity || null,
        ordered_quantity: erp.OrderedQuantity || null,
        location: erp.Location || null,
        timestamp: toDate(bigQueryObj.timestamp),
      }]);
    }

    // BigQuery Quality
    if (bqData.QMSData) {
      const qms = bqData.QMSData;
      await supabase.from("bigquery_quality").insert([{
        bigquery_id: bqId,
        order_number: qms.OrderNumber || null,
        item_number: qms.ItemNumber || null,
        inspection_result: qms.InspectionResult || null,
        rejection_reason: qms.RejectionReason || null,
        rejection_quantity: qms.RejectionQuantity || null,
        accepted_quantity: qms.AcceptedQuantity || null,
        timestamp: toDate(bigQueryObj.timestamp),
      }]);
    }

    // BigQuery Maintenance
    if (bqData.CMMSData) {
      const cmms = bqData.CMMSData;
      await supabase.from("bigquery_maintenance").insert([{
        bigquery_id: bqId,
        machine_id: cmms.MachineID || null,
        maintenance_status: cmms.MaintenanceStatus || null,
        last_maintenance_date: toDate(cmms.LastMaintenanceDate),
        next_maintenance_date: toDate(cmms.NextMaintenanceDate),
        maintenance_history: cmms.MaintenanceHistory || null,
        timestamp: toDate(bigQueryObj.timestamp),
      }]);
    }

    // BigQuery Process Variables
    if (bqData.ProcessVariables) {
      const pv = bqData.ProcessVariables;
      await supabase.from("bigquery_process_variables").insert([{
        bigquery_id: bqId,
        spindle_speed: pv.SpindleSpeed || null,
        feed_rate: pv.FeedRate || null,
        tool_wear: pv.ToolWear || null,
        coolant_temperature: pv.CoolantTemperature || null,
        vibration: pv.Vibration || null,
        power_consumption: pv.PowerConsumption || null,
        tool_change_count: pv.ToolChangeCount || null,
        material_temperature: pv.MaterialTemperature || null,
        part_dimensions: pv.PartDimensions || null,
        surface_finish: pv.SurfaceFinish || null,
        timestamp: toDate(bigQueryObj.timestamp),
      }]);
    }

    // BigQuery ISO55001
    if (bqData.ISO55001) {
      const iso = bqData.ISO55001;
      const al = iso.AssetLifecycle || {};
      const rm = iso.RiskManagement || {};
      const pi = iso.PerformanceIndicators || {};
      const comp = iso.Compliance || {};
      const ci = iso.ContinuousImprovement || {};

      await supabase.from("bigquery_iso55001").insert([{
        bigquery_id: bqId,
        asset_lifecycle_status: al.Status || null,
        maintenance_schedule: toDate(al.MaintenanceSchedule),
        risk_level: rm.RiskLevel || null,
        mitigation_plan: rm.MitigationPlan || null,
        oee: pi.OEE || null,
        mtbf: pi.MTBF || null,
        mttr: pi.MTTR || null,
        regulatory_status: comp.RegulatoryStatus || null,
        last_review_date: toDate(ci.LastReviewDate),
        planned_action: ci.PlannedAction || null,
        timestamp: toDate(bigQueryObj.timestamp),
      }]);
    }

    // BigQuery S88
    if (bqData.S88) {
      const s88 = bqData.S88;
      const bc = s88.BatchControl || {};
      const eq = bc.EquipmentModule || {};
      const cm = bc.ControlModule || {};
      const rm = bc.RecipeManagement || {};
      const hmi = bc.HMI || {};
      const dc = bc.DataCollection || {};
      const sc = bc.SafetyCompliance || {};

      await supabase.from("bigquery_s88").insert([{
        bigquery_id: bqId,
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
        timestamp: toDate(bigQueryObj.timestamp),
      }]);
    }
  } catch (error) {
    console.error(`Error processing BigQuery data for line ${lineId}:`, error);
  }
}

/**
 * Process a single site's data
 */
async function processSiteData(siteName, siteData) {
  try {
    // Get or create site with BU and GM
    const bu = getValue(siteData.BU);
    const gm = getValue(siteData.GM);
    const siteId = await getOrCreateSite(siteName, bu, gm);
    
    if (!siteId) {
      console.error(`Failed to get/create site: ${siteName}`);
      return;
    }

    console.log(`Processing site: ${siteName} (ID: ${siteId})`);

    // Define areas based on site
    let areaNames = [];
    if (siteName === "Dallas" || siteName === "Austin") {
      areaNames = ["Press", "Heat Treat", "Assembly"];
    } else if (siteName === "Smithfield") {
      areaNames = ["test"];
    } else if (siteName === "Site") {
      areaNames = ["Area"];
    }

    // Process each area
    for (const areaName of areaNames) {
      const areaData = siteData[areaName];
      if (!areaData) continue;

      const areaId = await getOrCreateArea(siteId, areaName);
      if (!areaId) {
        console.error(`Failed to get/create area: ${areaName}`);
        continue;
      }

      console.log(`  Processing area: ${areaName} (ID: ${areaId})`);

      // Process operations schedule if exists
      if (siteData.OperationsSchedule || siteData.operations_schedule) {
        await processOperationsSchedule(
          areaId, 
          siteData.OperationsSchedule || siteData.operations_schedule
        );
      }

      // Process each line in the area
      for (const lineKey in areaData) {
        const lineData = areaData[lineKey];
        if (!lineData || typeof lineData !== "object") continue;

        const lineId = await getOrCreateLine(areaId, lineKey);
        if (!lineId) {
          console.error(`Failed to get/create line: ${lineKey}`);
          continue;
        }

        console.log(`    Processing line: ${lineKey} (ID: ${lineId})`);

        // Process line-level data
        if (lineData.ERP) {
          await processErpOrders(lineId, lineData.ERP);
        }

        if (lineData.MES) {
          if (lineData.MES.KPIs) {
            await processMesKpis(lineId, lineData.MES.KPIs);
          }
          if (lineData.MES.Quality) {
            await processQualityControl(lineId, lineData.MES.Quality);
          }
          if (lineData.MES.Maintenance) {
            await processMaintenanceRecords(lineId, lineData.MES.Maintenance);
          }
        }

        if (lineData.S88) {
          await processS88BatchControl(lineId, lineData.S88);
        }

        if (lineData.Edge) {
          // Create a virtual asset for line-level edge data
          const edgeAssetId = await getOrCreateAsset(lineId, `${lineKey}_Edge`, "Edge");
          if (edgeAssetId) {
            await processEdgeProcessVariables(edgeAssetId, lineData.Edge);
          }
        }

        if (lineData["55001"] || lineData["5501"]) {
          await processIso55001Data(lineId, lineData["55001"] || lineData["5501"]);
        }

        if (lineData.Dashboard) {
          await processDashboardMetrics(lineId, lineData.Dashboard);
        }

        if (lineData.BigQuery) {
          await processBigQueryData(lineId, lineData.BigQuery);
        }

        // Process assets within this line
        // Look for asset-like keys (Cell, or direct asset names like Asset, Asset2)
        for (const potentialAssetKey in lineData) {
          const potentialAssetData = lineData[potentialAssetKey];
          
          // Skip known non-asset keys
          if (["ERP", "MES", "S88", "Edge", "55001", "5501", "Dashboard", "BigQuery"].includes(potentialAssetKey)) {
            continue;
          }

          // Check if this is an asset container or direct asset
          if (potentialAssetData && typeof potentialAssetData === "object") {
            // If it has 'edge', 'line', 'dispatch', 'unified' - it's likely an asset
            if (potentialAssetData.edge || potentialAssetData.line || 
                potentialAssetData.dispatch || potentialAssetData.unified) {
              
              const assetId = await getOrCreateAsset(lineId, potentialAssetKey);
              if (assetId) {
                console.log(`      Processing asset: ${potentialAssetKey} (ID: ${assetId})`);
                
                if (potentialAssetData.edge) {
                  await processAssetEdge(assetId, potentialAssetData.edge);
                }
                if (potentialAssetData.line) {
                  await processAssetLine(assetId, potentialAssetData.line);
                }
                if (potentialAssetData.unified) {
                  await processAssetUnified(assetId, potentialAssetData.unified);
                }
                if (potentialAssetData.dispatch) {
                  await processAssetDispatch(assetId, potentialAssetData.dispatch);
                }
              }
            } else {
              // Otherwise, iterate through nested assets
              for (const assetKey in potentialAssetData) {
                const assetData = potentialAssetData[assetKey];
                
                if (assetData && typeof assetData === "object" &&
                    (assetData.edge || assetData.line || assetData.dispatch || assetData.unified)) {
                  
                  const assetId = await getOrCreateAsset(lineId, assetKey);
                  if (assetId) {
                    console.log(`      Processing asset: ${assetKey} (ID: ${assetId})`);
                    
                    if (assetData.edge) {
                      await processAssetEdge(assetId, assetData.edge);
                    }
                    if (assetData.line) {
                      await processAssetLine(assetId, assetData.line);
                    }
                    if (assetData.unified) {
                      await processAssetUnified(assetId, assetData.unified);
                    }
                    if (assetData.dispatch) {
                      await processAssetDispatch(assetId, assetData.dispatch);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error processing site ${siteName}:`, error);
  }
}

/**
 * Main processing function for incoming data
 */
async function processIncomingData(data) {
  try {
    console.log("\n========================================");
    console.log("Processing new data update...");
    console.log("========================================");

    if (!data || !data.Enterprise) {
      console.warn("No Enterprise data found in payload");
      return;
    }

    const enterprise = data.Enterprise;

    // Process PICS data
    if (enterprise.PICS) {
      console.log("Processing PICS data...");
      await processPicsData(enterprise.PICS);
    }

    // Process IATECH data
    if (enterprise.IATECH) {
      console.log("Processing IATECH data...");
      await processIatechData(enterprise.IATECH);
    }

    // Process each site
    const siteNames = ["Dallas", "Austin", "Smithfield", "Site"];
    for (const siteName of siteNames) {
      if (enterprise[siteName]) {
        await processSiteData(siteName, enterprise[siteName]);
      }
    }

    console.log("========================================");
    console.log("✅ Data processing completed successfully");
    console.log("========================================\n");
  } catch (error) {
    console.error("❌ Error in processIncomingData:", error);
  }
}

// --- WebSocket Connection ---
console.log("Connecting to virtualfactory.online WebSocket...");
const socket = io.connect("https://virtualfactory.online:3000", {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity,
});

socket.on("connect", () => {
  console.log("✅ Connected to virtualfactory.online WebSocket");
  console.log("Waiting for data updates...\n");
});

socket.on("update", async (data) => {
  await processIncomingData(data);
});

socket.on("disconnect", (reason) => {
  console.log("❌ Disconnected from WebSocket. Reason:", reason);
  console.log("Attempting to reconnect...");
});

socket.on("connect_error", (error) => {
  console.error("Connection error:", error.message);
});

socket.on("error", (error) => {
  console.error("Socket error:", error);
});

// Handle process termination
process.on("SIGINT", () => {
  console.log("\n\nShutting down gracefully...");
  socket.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n\nShutting down gracefully...");
  socket.close();
  process.exit(0);
});
