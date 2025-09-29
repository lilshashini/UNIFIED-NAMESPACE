const io = require("socket.io-client");
require('dotenv').config();

const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

// --- Supabase setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

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
    if (payload.Enterprise && payload.Enterprise.PICS) {
      for (const devicePath in payload.Enterprise.PICS) {
        const deviceObj = payload.Enterprise.PICS[devicePath];
        for (const subDevice in deviceObj) {
          const subObj = deviceObj[subDevice];
          for (const levelKey in subObj) {
            const levelObj = subObj[levelKey];
            await supabase.from("pics_data").insert([
              {
                record_id: recordId,
                device_path: `${devicePath}/${subDevice}/${levelKey}`,
                value: levelObj.value,
                timestamp: levelObj.timestamp ? new Date(levelObj.timestamp) : null,
              },
            ]);
          }
        }
      }
    }

    // --- Site/Area/Line/Cell/Asset ---
    if (payload.Enterprise && payload.Enterprise.Site) {
      for (const areaKey in payload.Enterprise.Site) {
        const areaObj = payload.Enterprise.Site[areaKey];
        for (const lineKey in areaObj) {
          const lineObj = areaObj[lineKey];
          for (const cellKey in lineObj) {
            const cellObj = lineObj[cellKey];
            for (const assetKey in cellObj) {
              const assetObj = cellObj[assetKey];
              // Insert asset
              const { data: insertedAsset, error: assetError } = await supabase
                .from("assets")
                .insert([
                  {
                    record_id: recordId,
                    asset_name: assetKey,
                    site: areaKey,
                    area: lineKey,
                    line: cellKey,
                    cell: assetKey,
                  },
                ])
                .select("id")
                .single();
              if (assetError) throw assetError;
              const assetId = insertedAsset.id;

              // Asset edge
              if (assetObj.edge && assetObj.edge.value) {
                let edgeData;
                try {
                  edgeData = JSON.parse(assetObj.edge.value);
                } catch (e) {
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
                let lineData;
                try {
                  lineData = JSON.parse(assetObj.line.value);
                } catch (e) {
                  lineData = {};
                }
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
                  const dispatchObj = assetObj.dispatch[dispatchType];
                  if (dispatchObj.value) {
                    let dispatchData;
                    try {
                      dispatchData = JSON.parse(dispatchObj.value);
                    } catch (e) {
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
                let unifiedData;
                try {
                  unifiedData = JSON.parse(assetObj.unified.value);
                } catch (e) {
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
          }
        }
      }
    }

    // --- Austin/Press/Line/ERP/MES/S88/Edge/55001/Dashboard ---
    if (payload.Austin && payload.Austin.Press) {
      for (const lineKey in payload.Austin.Press) {
        const lineObj = payload.Austin.Press[lineKey];
        // Insert production line
        const { data: insertedLine, error: lineError } = await supabase
          .from("production_lines")
          .insert([
            {
              record_id: recordId,
              location: payload.Austin.Location?.value || null,
              business_unit: payload.Austin.BU?.value || null,
              general_manager: payload.Austin.GM?.value || null,
              line_name: lineKey,
            },
          ])
          .select("id")
          .single();
        if (lineError) throw lineError;
        const lineId = insertedLine.id;

        // ERP
        if (lineObj.ERP) {
          const erp = lineObj.ERP;
          await supabase.from("erp_orders").insert([
            {
              line_id: lineId,
              order_number: erp.OrderNumber?.value,
              order_status: erp.OrderStatus?.value,
              item_number: erp.ItemNumber?.value,
              item_description: erp.ItemDescription?.value,
              ordered_quantity: erp.OrderedQuantity?.value,
              produced_quantity: erp.ProducedQuantity?.value,
              remaining_quantity: erp.RemainingQuantity?.value,
              available_quantity: erp.AvailableQuantity?.value,
              reserved_quantity: erp.ReservedQuantity?.value,
              scheduled_start_time: erp.ScheduledStartTime?.value ? new Date(erp.ScheduledStartTime.value) : null,
              scheduled_end_time: erp.ScheduledEndTime?.value ? new Date(erp.ScheduledEndTime.value) : null,
              actual_start_time: erp.ActualStartTime?.value ? new Date(erp.ActualStartTime.value) : null,
              actual_end_time: erp.ActualEndTime?.value ? new Date(erp.ActualEndTime.value) : null,
              bom: erp.BOM?.value,
              location: erp.Location?.value,
            },
          ]);
        }

        // MES KPIs
        if (lineObj.MES && lineObj.MES.KPIs) {
          const kpi = lineObj.MES.KPIs;
          await supabase.from("mes_kpis").insert([
            {
              line_id: lineId,
              oee: kpi.OEE?.value,
              availability: kpi.Availability?.value,
              performance: kpi.Performance?.value,
              quality: kpi.Quality?.value,
              teep: kpi.TEEP?.value,
              mtbf: kpi.MTBF?.value,
              mttr: kpi.MTTR?.value,
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
              order_number: qc.OrderNumber?.value,
              item_number: qc.ItemNumber?.value,
              inspection_result: qc.InspectionResult?.value,
              rejection_reason: qc.RejectionReason?.value,
              accepted_quantity: qc.AcceptedQuantity?.value,
              rejection_quantity: qc.RejectionQuantity?.value,
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
              machine_id: m.MachineID?.value,
              maintenance_status: m.MaintenanceStatus?.value,
              last_maintenance_date: m.LastMaintenanceDate?.value ? new Date(m.LastMaintenanceDate.value) : null,
              next_maintenance_date: m.NextMaintenanceDate?.value ? new Date(m.NextMaintenanceDate.value) : null,
              maintenance_history: m.MaintenanceHistory?.value,
              timestamp: m.MachineID?.timestamp ? new Date(m.MachineID.timestamp) : null,
            },
          ]);
        }

        // S88 Batch Control
        if (lineObj.S88 && lineObj.S88.value) {
          let s88Data;
          try {
            s88Data = JSON.parse(lineObj.S88.value);
          } catch (e) {
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
                batch_mixing_tank_status: eq.BatchMixingTankStatus,
                bottler_status: eq.BottlerStatus,
                capper_status: eq.CapperStatus,
                temperature_controller: cm.TemperatureController,
                volume_control: cm.VolumeControl,
                soda_recipe: rm.SodaRecipe,
                production_parameters: rm.ProductionParameters,
                operator_interface_status: hmi.OperatorInterfaceStatus,
                process_data: dc.ProcessData,
                quality_data: dc.QualityData,
                safety_status: sc.SafetyStatus,
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
              state: edge.State?.value,
              waste: edge.Waste?.value,
              infeed: edge.Infeed?.value,
              outfeed: edge.Outfeed?.value,
              spindle_speed: edge.Process?.SpindleSpeed?.value,
              feed_rate: edge.Process?.FeedRate?.value,
              tool_wear: edge.Process?.ToolWear?.value,
              coolant_temperature: edge.Process?.CoolantTemperature?.value,
              vibration: edge.Process?.Vibration?.value,
              power_consumption: edge.Process?.PowerConsumption?.value,
              tool_change_count: edge.Process?.ToolChangeCount?.value,
              material_temperature: edge.Process?.MaterialTemperature?.value,
              part_dimensions: edge.Process?.PartDimensions?.value,
              surface_finish: edge.Process?.SurfaceFinish?.value,
              timestamp: edge.State?.timestamp ? new Date(edge.State.timestamp) : null,
            },
          ]);
        }

        // ISO 55001 Data
        if (lineObj["55001"] && lineObj["55001"].value) {
          let isoData;
          try {
            isoData = JSON.parse(lineObj["55001"].value);
          } catch (e) {
            isoData = {};
          }
          if (isoData.AssetLifecycle) {
            await supabase.from("iso55001_data").insert([
              {
                line_id: lineId,
                lifecycle_status: isoData.AssetLifecycle.Status,
                maintenance_schedule: isoData.AssetLifecycle.MaintenanceSchedule ? new Date(isoData.AssetLifecycle.MaintenanceSchedule) : null,
                risk_level: isoData.RiskManagement?.RiskLevel,
                mitigation_plan: isoData.RiskManagement?.MitigationPlan,
                oee: isoData.PerformanceIndicators?.OEE,
                mtbf: isoData.PerformanceIndicators?.MTBF,
                mttr: isoData.PerformanceIndicators?.MTTR,
                regulatory_status: isoData.Compliance?.RegulatoryStatus,
                last_review_date: isoData.ContinuousImprovement?.LastReviewDate ? new Date(isoData.ContinuousImprovement.LastReviewDate) : null,
                planned_action: isoData.ContinuousImprovement?.PlannedAction,
                timestamp: lineObj["55001"].timestamp ? new Date(lineObj["55001"].timestamp) : null,
              },
            ]);
          }
        }

        // Dashboard Metrics
        if (lineObj.Dashboard && lineObj.Dashboard.value) {
          let dashData;
          try {
            dashData = JSON.parse(lineObj.Dashboard.value);
          } catch (e) {
            dashData = {};
          }
          await supabase.from("dashboard_metrics").insert([
            {
              line_id: lineId,
              oee: dashData.OEE,
              availability: dashData.Availability,
              performance: dashData.Performance,
              quality: dashData.Quality,
              current_batch_status: dashData.CurrentBatchStatus,
              maintenance_status: dashData.MaintenanceStatus,
              timestamp: lineObj.Dashboard.timestamp ? new Date(lineObj.Dashboard.timestamp) : null,
            },
          ]);
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
