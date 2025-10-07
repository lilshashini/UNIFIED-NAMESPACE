import os
import re
import json
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Optional, Any
import streamlit as st
import pandas as pd
import matplotlib.pyplot as plt
from dotenv import load_dotenv
from supabase import create_client, Client
from openai import AzureOpenAI
import logging
from logging.handlers import RotatingFileHandler

load_dotenv()

# =============================================================================
# LOGGING CONFIGURATION
# =============================================================================

def setup_logging():
    """Configure logging for the application"""
    logger = logging.getLogger('improved_manufacturing_chatbot')
    logger.setLevel(logging.INFO)
    
    # Clear existing handlers to prevent duplicates
    logger.handlers.clear()
    
    # Console handler
    console_formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(console_formatter)
    logger.addHandler(console_handler)
    
    # File handler with rotation
    try:
        file_handler = RotatingFileHandler(
            'improved_chatbot.log', 
            maxBytes=10485760,  # 10MB
            backupCount=5
        )
        file_handler.setLevel(logging.INFO)
        file_handler.setFormatter(console_formatter)
        logger.addHandler(file_handler)
    except Exception as e:
        logger.warning(f"Could not create file handler: {e}")
    
    logger.propagate = False
    return logger

# Initialize logger
logger = setup_logging()

# =============================================================================
# CONFIGURATION & INITIALIZATION
# =============================================================================

class Config:
    """Configuration management for the chatbot"""
    SUPABASE_URL = os.getenv("SUPABASE_URL")
    SUPABASE_KEY = os.getenv("SUPABASE_KEY")
    AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY")
    AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT")
    AZURE_OPENAI_DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4.1")
    AZURE_OPENAI_API_VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2025-01-01-preview")
    
    # SQL safety settings
    MAX_RESULTS = 1000
    ALLOWED_TABLES = [
        "dashboard_metrics", "production_lines", "maintenance_records",
        "quality_control", "edge_process_variables", "erp_orders",
        "s88_batch_control", "pics_data", "operations_schedule", "assets",
        "iatech_data", "asset_edge_data", "asset_line_data", "asset_dispatch",
        "asset_kpi_data", "mes_kpis", "bigquery", "bigquery_kpis",
        "bigquery_quality", "bigquery_erp", "bigquery_maintenance",
        "bigquery_process_variables", "bigquery_iso55001", "bigquery_s88",
        "iso55001_data", "enterprise", "data_records", "documents"
    ]
    DANGEROUS_KEYWORDS = ["DROP", "DELETE", "TRUNCATE", "ALTER", "CREATE", "INSERT", "UPDATE"]

# Initialize clients
@st.cache_resource
def init_clients():
    """Initialize Supabase and Azure OpenAI clients"""
    if not all([Config.SUPABASE_URL, Config.SUPABASE_KEY]):
        st.error("Missing Supabase credentials. Check your .env file.")
        st.stop()
    
    supabase = create_client(Config.SUPABASE_URL, Config.SUPABASE_KEY)
    
    azure_client = None
    if all([Config.AZURE_OPENAI_API_KEY, Config.AZURE_OPENAI_ENDPOINT]):
        azure_client = AzureOpenAI(
            api_key=Config.AZURE_OPENAI_API_KEY,
            api_version=Config.AZURE_OPENAI_API_VERSION,
            azure_endpoint=Config.AZURE_OPENAI_ENDPOINT
        )
    
    return supabase, azure_client


# =============================================================================
# SQL SAFETY & VALIDATION
# =============================================================================

class SQLValidator:
    """Validates and sanitizes SQL queries for safety"""
    
    @staticmethod
    def is_safe_query(sql: str) -> Tuple[bool, str]:
        """Check if SQL query is safe to execute"""
        sql_upper = sql.upper()
        
        # Check for dangerous keywords
        for keyword in Config.DANGEROUS_KEYWORDS:
            if keyword in sql_upper:
                return False, f"Dangerous operation '{keyword}' not allowed"
        
        # Must be a SELECT query
        if not sql_upper.strip().startswith("SELECT"):
            return False, "Only SELECT queries are allowed"
        
        # Check for allowed tables
        table_pattern = r'\bFROM\s+(\w+)'
        tables = re.findall(table_pattern, sql_upper)
        for table in tables:
            if table.lower() not in Config.ALLOWED_TABLES:
                return False, f"Access to table '{table}' not allowed"
        
        # Check for SQL injection patterns
        injection_patterns = [
            r";\s*DROP",
            r";\s*DELETE",
            r"--",
            r"/\*.*\*/",
            r"UNION.*SELECT",
            r"EXEC(\s|\()",
            r"EXECUTE(\s|\()"
        ]
        for pattern in injection_patterns:
            if re.search(pattern, sql_upper):
                return False, "Potential SQL injection detected"
        
        return True, ""

# =============================================================================
# SIMPLE SQL GENERATOR  
# =============================================================================

class SimpleSQLGenerator:
    """Generates clean, simple SQL queries without unnecessary complexity"""
    
    @staticmethod
    def clean_value(value: str) -> str:
        """Clean and normalize string values"""
        if not value:
            return ""
        # Remove possessives and normalize
        value = value.replace("'s", "").replace("'", "")
        # Keep alphanumeric characters, spaces, and hyphens
        value = re.sub(r'[^a-zA-Z0-9\s-]', '', value)
        return value.strip()
    
    @staticmethod
    def generate_oee_query(site: str = None, area: str = None, line: str = None, 
                          time_filter: str = None, limit: int = 1) -> Dict[str, Any]:
        """Generate clean OEE query using correct schema"""
        
        where_conditions = []
        
        # Use correct column names based on actual schema
        if site:
            clean_site = SimpleSQLGenerator.clean_value(site)
            where_conditions.append(f"pl.location = '{clean_site}'")
        if line:
            clean_line = SimpleSQLGenerator.clean_value(line)
            where_conditions.append(f"pl.line_name = '{clean_line}'")
        
        # For area filtering, need to join with assets table since production_lines doesn't have area
        joins = "FROM production_lines pl JOIN dashboard_metrics dm ON pl.id = dm.line_id"
        area_column = ""
        if area:
            clean_area = SimpleSQLGenerator.clean_value(area)
            joins += " JOIN assets a ON a.line_id = pl.id"
            where_conditions.append(f"a.area = '{clean_area}'")
            area_column = "a.area,"
        
        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"
        
        time_condition = ""
        if time_filter:
            time_condition = f" AND dm.timestamp >= NOW() - INTERVAL '{time_filter}'"
        
        sql = f"""
        SELECT 
            pl.line_name,
            pl.location,
            {area_column}
            dm.oee,
            dm.availability,
            dm.performance,
            dm.quality,
            dm.timestamp
        {joins}
        WHERE {where_clause}{time_condition}
        ORDER BY dm.timestamp DESC
        LIMIT {limit}
        """
        
        return {
            'sql': sql.strip(),
            'params': [],
            'explanation': f'OEE metrics for {line or "all lines"} in {site or "all sites"}{(" " + area) if area else ""}'
        }
    
    @staticmethod
    def generate_maintenance_query(site: str = None, machine: str = None, 
                                overdue_only: bool = False) -> Dict[str, Any]:
        """Generate maintenance query using correct schema with machine_id casting"""

        where_conditions = []

        if site:
            clean_site = SimpleSQLGenerator.clean_value(site)
            where_conditions.append(f"pl.location = '{clean_site}'")
        if machine:
            clean_machine = SimpleSQLGenerator.clean_value(machine)
            where_conditions.append(f"a.asset_name ILIKE '%{clean_machine}%'")
        if overdue_only:
            where_conditions.append("mr.next_maintenance_date < NOW()")

        # Default condition to avoid syntax issues
        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"

        sql = f"""
        SELECT a.id AS asset_id, a.asset_name, a.line_id,
               mr.maintenance_status, mr.last_maintenance_date,
               mr.next_maintenance_date, mr.timestamp
        FROM assets a
        JOIN maintenance_records mr 
            ON a.id = CAST(SUBSTRING(mr.machine_id FROM '[0-9]+') AS INTEGER)
        WHERE mr.next_maintenance_date < NOW()
        AND (mr.maintenance_status IS NULL OR LOWER(mr.maintenance_status) NOT IN ('completed', 'done'))
        ORDER BY mr.timestamp DESC
        LIMIT 1000;
        """

        return {
            'sql': sql.strip(),
            'params': [],
            'explanation': f"Maintenance records for {machine or 'all machines'} in {site or 'all sites'}"
        }

    
    @staticmethod
    def generate_quality_query(site: str = None, area: str = None, 
                             time_filter: str = "24 hours") -> Dict[str, Any]:
        """Generate quality metrics query using correct schema"""
        
        where_conditions = []
        
        # Use correct column names - quality_control has rejection_reason not defect_type
        if site:
            clean_site = SimpleSQLGenerator.clean_value(site)
            where_conditions.append(f"pl.location = '{clean_site}'")
        
        # For area filtering, need to join with assets table
        joins = "FROM quality_control qc JOIN production_lines pl ON qc.line_id = pl.id"
        area_column = ""
        if area:
            clean_area = SimpleSQLGenerator.clean_value(area)
            joins += " JOIN assets a ON a.line_id = pl.id"
            where_conditions.append(f"a.area = '{clean_area}'")
            area_column = "a.area,"
        
        where_conditions.append(f"qc.timestamp >= NOW() - INTERVAL '{time_filter}'")
        
        where_clause = " AND ".join(where_conditions)
        
        sql = f"""
        SELECT 
            pl.line_name,
            pl.location,
            {area_column}
            qc.item_number,
            qc.rejection_reason,
            qc.rejection_quantity,
            qc.accepted_quantity,
            qc.timestamp
        {joins}
        WHERE {where_clause}
        ORDER BY qc.rejection_quantity DESC
        LIMIT 20
        """
        
        return {
            'sql': sql.strip(),
            'params': [],
            'explanation': f'Quality issues for last {time_filter} in {site or "all sites"}'
        }
    
    @staticmethod
    def generate_batch_control_query(recipe_filter: str = None, 
                                   time_filter: str = "7 days") -> Dict[str, Any]:
        """Generate S88 batch control query for soda recipes and production parameters"""
        
        where_conditions = []
        where_conditions.append(f"bc.timestamp >= NOW() - INTERVAL '{time_filter}'")
        
        if recipe_filter:
            clean_recipe = SimpleSQLGenerator.clean_value(recipe_filter)
            where_conditions.append(f"bc.soda_recipe ILIKE '%{clean_recipe}%'")
        
        where_clause = " AND ".join(where_conditions)
        
        sql = f"""
        SELECT 
            pl.line_name,
            pl.location,
            bc.soda_recipe,
            bc.production_parameters,
            bc.batch_mixing_tank_status,
            bc.bottler_status,
            bc.capper_status,
            bc.temperature_controller,
            bc.volume_control,
            bc.operator_interface_status,
            bc.quality_data,
            bc.safety_status,
            bc.timestamp
        FROM s88_batch_control bc
        JOIN production_lines pl ON bc.line_id = pl.id
        WHERE {where_clause}
        ORDER BY bc.timestamp DESC
        LIMIT 20
        """
        
        return {
            'sql': sql.strip(),
            'params': [],
            'explanation': f'Batch control data for {recipe_filter or "all recipes"} in last {time_filter}'
        }
    
    @staticmethod
    def generate_item_rejection_query(time_filter: str = "30 days") -> Dict[str, Any]:
        """Generate query for item numbers with highest rejection quantities"""
        
        sql = f"""
        SELECT 
            qc.item_number,
            pl.line_name,
            pl.location,
            qc.rejection_reason,
            SUM(qc.rejection_quantity) as total_rejection_quantity,
            SUM(qc.accepted_quantity) as total_accepted_quantity,
            COUNT(*) as rejection_incidents
        FROM quality_control qc
        JOIN production_lines pl ON qc.line_id = pl.id
        WHERE qc.timestamp >= NOW() - INTERVAL '{time_filter}'
        GROUP BY qc.item_number, pl.line_name, pl.location, qc.rejection_reason
        ORDER BY total_rejection_quantity DESC
        LIMIT 20
        """
        
        return {
            'sql': sql.strip(),
            'params': [],
            'explanation': f'Items with highest rejection quantities in last {time_filter}'
        }

# =============================================================================
# IMPROVED NATURAL LANGUAGE TO SQL TRANSLATOR
# =============================================================================

class ImprovedNLToSQLTranslator:
    """Improved translator that generates clean, simple SQL queries"""
    
    def __init__(self, azure_client: Optional[AzureOpenAI], executor):
        self.azure_client = azure_client
        self.executor = executor
        self.system_prompt = self._build_system_prompt()
    
    def _get_schema_info(self) -> Dict[str, List[str]]:
        """Get schema information from executor"""
        return self.executor.get_schema_info()
    
    def _build_system_prompt(self) -> str:
        """Build system prompt that encourages clean SQL generation"""
        
        # Get actual schema from database
        schema_info = self._get_schema_info()
        schema_text = "\nDATABASE SCHEMA (Key Tables):\n"
        
        # Highlight the most important tables for manufacturing queries
        key_tables = [
            'production_lines', 'dashboard_metrics', 'assets', 'maintenance_records',
            'quality_control', 'asset_kpi_data', 'mes_kpis', 's88_batch_control',
            'erp_orders', 'edge_process_variables'
        ]
        
        for table in key_tables:
            if table in schema_info:
                columns = ', '.join(schema_info[table])
                schema_text += f"- {table}: {columns}\n"
        
        # Build the prompt without using f-string for the template part
        prompt = """You are a SQL expert for a manufacturing database. Generate CLEAN, SIMPLE PostgreSQL queries.
{}

CRITICAL COLUMN MAPPING RULES:
- production_lines has: id, enterprise_id, record_id, location, business_unit, general_manager, line_name
- dashboard_metrics has: id, line_id, oee, availability, performance, quality, current_batch_status, maintenance_status, timestamp
- assets has: id, record_id, line_id, asset_name, site, area, line, cell
- quality_control has: id, line_id, order_number, item_number, inspection_result, rejection_reason, accepted_quantity, rejection_quantity, timestamp
- maintenance_records has: id, line_id, machine_id, maintenance_status, last_maintenance_date, next_maintenance_date, maintenance_history, timestamp
- s88_batch_control has: id, line_id, batch_mixing_tank_status, bottler_status, capper_status, temperature_controller, volume_control, soda_recipe, production_parameters, operator_interface_status, process_data, quality_data, safety_status, timestamp

IMPORTANT NOTES:
- Use 'location' not 'site' for production_lines filtering (Katunayake, Biyagama, etc.)
- Use 'rejection_reason' not 'defect_type' in quality_control
- For OEE data, you can use dashboard_metrics, asset_kpi_data, or mes_kpis tables
- For batch/recipe data, use s88_batch_control table
- production_lines does NOT have 'area' - use assets table for area information
- For maintenance, join assets and maintenance_records on asset relationships

CRITICAL RULES FOR CLEAN SQL:
1. Use simple WHERE clauses with = for exact matches
2. Use ILIKE '%value%' only when fuzzy matching is truly needed
3. Avoid REGEXP_REPLACE unless absolutely necessary
4. NO parameterized queries - embed values directly in SQL
5. Keep JOINs simple and clear
6. Always ORDER BY timestamp DESC for time-series data
7. Use reasonable LIMIT values (1 for "current", 10-50 for lists)

EXAMPLE PATTERNS:
- "Current OEE for Line1 in Katunayake" →
  SELECT pl.line_name, dm.oee, dm.timestamp
  FROM production_lines pl
  JOIN dashboard_metrics dm ON pl.id = dm.line_id
  WHERE pl.location = 'Katunayake'
  ORDER BY dm.timestamp DESC LIMIT 1

- "Maintenance status in Biyagama" →
    SELECT a.id AS asset_id, a.asset_name, a.line_id,
            mr.maintenance_status, mr.last_maintenance_date,
            mr.next_maintenance_date, mr.timestamp
    FROM assets a
    JOIN maintenance_records mr 
            ON a.id = CAST(SUBSTRING(mr.machine_id FROM '[0-9]+') AS INTEGER)
    WHERE mr.next_maintenance_date < NOW()
        AND (mr.maintenance_status IS NULL OR LOWER(mr.maintenance_status) NOT IN ('completed', 'done'))
    ORDER BY mr.timestamp DESC
    LIMIT 1000;

RESPONSE FORMAT (JSON):
{}

For conceptual questions (definitions, explanations):
{}

Generate clean, executable SQL. Avoid unnecessary complexity."""
        
        # Format with the schema and JSON examples
        json_example = '''{
  "sql": "Clean SQL query here",
  "params": [],
  "explanation": "Brief explanation",
  "is_conceptual": false
}'''
        
        conceptual_example = '''{
  "is_conceptual": true,
  "answer": "Your explanation here",
  "explanation": "This is a conceptual question"
}'''
        
        return prompt.format(schema_text, json_example, conceptual_example)

    def translate(self, question: str, context: Dict = None) -> Dict[str, Any]:
        """Translate natural language to SQL"""
        
        logger.info(f"=== TRANSLATING QUERY ===")
        logger.info(f"User Question: {question}")
        logger.info(f"Context: {context}")
        
        # Check if it's a conceptual question
        conceptual_keywords = ['what is', 'define', 'explain', 'meaning of', 'definition', 
                              'how does', 'why is', 'tell me about']
        is_likely_conceptual = any(kw in question.lower() for kw in conceptual_keywords)
        
        # Try LLM first
        if self.azure_client:
            try:
                result = self._llm_translate(question, context)
                
                if result.get('is_conceptual'):
                    return result
                
                if 'sql' in result:
                    is_safe, error = SQLValidator.is_safe_query(result['sql'])
                    if not is_safe:
                        return {'error': f"Generated SQL is unsafe: {error}"}
                
                return result
                
            except Exception as e:
                logger.warning(f"LLM translation failed: {str(e)}. Using fallback.")
        
        # Handle conceptual questions
        if is_likely_conceptual:
            return self._handle_conceptual_question(question)
        
        # Fallback to simple rule-based parsing
        return self._fallback_translate(question, context)
    
    def _llm_translate(self, question: str, context: Dict) -> Dict[str, Any]:
        """Use LLM to translate"""
        user_message = f"Question: {question}"
        
        if context:
            user_message += f"\n\nContext filters: {json.dumps(context)}"
        
        response = self.azure_client.chat.completions.create(
            model=Config.AZURE_OPENAI_DEPLOYMENT,
            messages=[
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": user_message}
            ],
            temperature=0,
            max_tokens=30000
        )
        
        result_text = response.choices[0].message.content.strip()
        
        # Extract JSON from response
        json_match = re.search(r'\{.*\}', result_text, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group())
            logger.info(f"LLM Generated: {result}")
            return result
        else:
            return {'error': 'Failed to parse LLM response'}
    
    def _handle_conceptual_question(self, question: str) -> Dict[str, Any]:
        """Handle conceptual questions"""
        question_lower = question.lower()
        
        concepts = {
            'oee': 'OEE (Overall Equipment Effectiveness) measures manufacturing productivity as the percentage of time that is truly productive. It equals Availability × Performance × Quality. A perfect OEE of 100% means producing only good parts, as fast as possible, with no downtime.',
            'availability': 'Availability measures the percentage of scheduled time that equipment is available to operate. It accounts for downtime events like equipment failures, material shortages, and changeovers.',
            'performance': 'Performance measures how fast equipment runs compared to its designed capacity. It accounts for factors like slow cycles and minor stops that reduce the manufacturing speed.',
            'quality': 'Quality measures the percentage of good units produced versus total units started. It accounts for defective units and units that need rework.',
            'mtbf': 'MTBF (Mean Time Between Failures) is the average time between system breakdowns. Higher MTBF indicates more reliable equipment.',
            'mttr': 'MTTR (Mean Time To Repair) is the average time needed to repair failed equipment. Lower MTTR indicates faster maintenance response.',
        }
        
        for key, definition in concepts.items():
            if key in question_lower:
                return {
                    'is_conceptual': True,
                    'answer': definition,
                    'explanation': f'Conceptual explanation of {key.upper()}'
                }
        
        return {
            'error': 'I can explain manufacturing concepts like OEE, Availability, Performance, Quality, MTBF, and MTTR. Please ask about available data or rephrase your question.'
        }
    
    def _fallback_translate(self, question: str, context: Dict) -> Dict[str, Any]:
        """Simple fallback parser"""
        question_lower = question.lower()
        
        # Extract context
        site = context.get('site') if context else None
        area = None
        line = None
        
        # Parse from question
        if 'Katunayake' in question_lower:
            site = 'Katunayake'
        elif 'Biyagama' in question_lower:
            site = 'Biyagama'
        
        if 'press' in question_lower:
            area = 'Press'
        elif 'assembly' in question_lower:
            area = 'Assembly'
        
        line_match = re.search(r'line\s*(\d+)', question_lower)
        if line_match:
            line = f"Line{line_match.group(1)}"
        
        # Route to appropriate generator
        if 'oee' in question_lower or ('current' in question_lower and 'maintenance' not in question_lower):
            time_match = re.search(r'last\s+(\d+)\s+(hour|day|week)', question_lower)
            time_filter = f"{time_match.group(1)} {time_match.group(2)}s" if time_match else None
            limit = 100 if time_filter else 1
            return SimpleSQLGenerator.generate_oee_query(site, area, line, time_filter, limit)
        
        elif 'maintenance' in question_lower or 'overdue' in question_lower:
            machine_match = re.search(r'machine[-\s]*(\d+)', question_lower)
            machine = f"Machine{machine_match.group(1)}" if machine_match else None
            overdue = 'overdue' in question_lower
            return SimpleSQLGenerator.generate_maintenance_query(site, machine, overdue)
        
        elif 'quality' in question_lower or 'reject' in question_lower or 'defect' in question_lower:
            time_match = re.search(r'last\s+(\d+)\s+(hour|day|week)', question_lower)
            time_filter = f"{time_match.group(1)} {time_match.group(2)}s" if time_match else "24 hours"
            return SimpleSQLGenerator.generate_quality_query(site, area, time_filter)
        
        elif 'soda' in question_lower or 'recipe' in question_lower or 'batch' in question_lower:
            time_match = re.search(r'last\s+(\d+)\s+(hour|day|week)', question_lower)
            time_filter = f"{time_match.group(1)} {time_match.group(2)}s" if time_match else "7 days"
            recipe_filter = None
            # Try to extract recipe name
            recipe_match = re.search(r'recipe\s+(\w+)', question_lower)
            if recipe_match:
                recipe_filter = recipe_match.group(1)
            return SimpleSQLGenerator.generate_batch_control_query(recipe_filter, time_filter)
        
        elif 'item' in question_lower and ('reject' in question_lower or 'highest' in question_lower):
            time_match = re.search(r'last\s+(\d+)\s+(day|week|month)', question_lower)
            time_filter = f"{time_match.group(1)} {time_match.group(2)}s" if time_match else "30 days"
            return SimpleSQLGenerator.generate_item_rejection_query(time_filter)
        
        elif 'report' in question_lower and site:
            # Generate a comprehensive report for the site
            return SimpleSQLGenerator.generate_oee_query(site, area, None, "24 hours", limit=10)
        
        # Default fallback
        return SimpleSQLGenerator.generate_oee_query(site, area, line)

# =============================================================================
# QUERY EXECUTOR
# =============================================================================

class QueryExecutor:
    """Executes SQL queries against Supabase"""
    
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self._schema_cache = None
    
    def get_schema_info(self) -> Dict[str, List[str]]:
        """Get database schema information"""
        if self._schema_cache:
            return self._schema_cache
        
        try:
            # Correct schema based on actual database structure
            schema = {
                'asset_dispatch': ['id', 'asset_id', 'count_type', 'last_count', 'count', 'dispatch_timestamp', 'timestamp'],
                'asset_edge_data': ['id', 'asset_id', 'state', 'outfeed', 'waste', 'infeed', 'total_strokes', 'stroke_raw', 'waste_injected', 'timestamp'],
                'asset_kpi_data': ['id', 'asset_id', 'availability', 'performance', 'quality', 'oee', 'run_time', 'total_time', 'planned_downtime', 'unplanned_downtime', 'total_strokes', 'cycle_time', 'timestamp'],
                'asset_line_data': ['id', 'asset_id', 'timestamp', 'run_enable', 'outfeed', 'infeed', 'scheduled_rate', 'run_start_time', 'state', 'waste', 'runtime', 'run_id', 'current_production_rate'],
                'assets': ['id', 'record_id', 'line_id', 'asset_name', 'site', 'area', 'line', 'cell'],
                'bigquery': ['id', 'line_id', 'production_line', 'timestamp'],
                'bigquery_erp': ['id', 'bigquery_id', 'order_number', 'order_status', 'scheduled_start_time', 'scheduled_end_time', 'actual_start_time', 'actual_end_time', 'produced_quantity', 'remaining_quantity', 'item_number', 'bom', 'item_description', 'available_quantity', 'reserved_quantity', 'ordered_quantity', 'location', 'timestamp'],
                'bigquery_iso55001': ['id', 'bigquery_id', 'lifecycle_status', 'maintenance_schedule', 'risk_level', 'mitigation_plan', 'oee', 'mtbf', 'mttr', 'regulatory_status', 'last_review_date', 'planned_action', 'timestamp'],
                'bigquery_kpis': ['id', 'bigquery_id', 'availability', 'quality', 'performance', 'oee', 'teep', 'mttr', 'mtbf', 'timestamp'],
                'bigquery_maintenance': ['id', 'bigquery_id', 'machine_id', 'maintenance_status', 'last_maintenance_date', 'next_maintenance_date', 'maintenance_history', 'timestamp'],
                'bigquery_process_variables': ['id', 'bigquery_id', 'spindle_speed', 'feed_rate', 'tool_wear', 'coolant_temperature', 'vibration', 'power_consumption', 'tool_change_count', 'material_temperature', 'part_dimensions', 'surface_finish', 'timestamp'],
                'bigquery_quality': ['id', 'bigquery_id', 'order_number', 'item_number', 'inspection_result', 'rejection_reason', 'rejection_quantity', 'accepted_quantity', 'timestamp'],
                'bigquery_s88': ['id', 'bigquery_id', 'batch_mixing_tank_status', 'bottler_status', 'capper_status', 'temperature_controller', 'volume_control', 'soda_recipe', 'production_parameters', 'operator_interface_status', 'process_data', 'quality_data', 'safety_status', 'timestamp'],
                'dashboard_metrics': ['id', 'line_id', 'oee', 'availability', 'performance', 'quality', 'current_batch_status', 'maintenance_status', 'timestamp'],
                'data_records': ['id', 'idx', 'timestamp'],
                'documents': ['id', 'content', 'metadata', 'embedding'],
                'edge_process_variables': ['id', 'line_id', 'state', 'waste', 'infeed', 'outfeed', 'spindle_speed', 'feed_rate', 'tool_wear', 'coolant_temperature', 'vibration', 'power_consumption', 'tool_change_count', 'material_temperature', 'part_dimensions', 'surface_finish', 'timestamp'],
                'enterprise': ['id', 'name', 'timestamp'],
                'erp_orders': ['id', 'line_id', 'order_number', 'order_status', 'item_number', 'item_description', 'ordered_quantity', 'produced_quantity', 'remaining_quantity', 'available_quantity', 'reserved_quantity', 'scheduled_start_time', 'scheduled_end_time', 'actual_start_time', 'actual_end_time', 'bom', 'location'],
                'iatech_data': ['id', 'enterprise_id', 'name', 'value', 'timestamp'],
                'iso55001_data': ['id', 'line_id', 'lifecycle_status', 'maintenance_schedule', 'risk_level', 'mitigation_plan', 'oee', 'mtbf', 'mttr', 'regulatory_status', 'last_review_date', 'planned_action', 'timestamp'],
                'maintenance_records': ['id', 'line_id', 'machine_id', 'maintenance_status', 'last_maintenance_date', 'next_maintenance_date', 'maintenance_history', 'timestamp'],
                'mes_kpis': ['id', 'line_id', 'oee', 'availability', 'performance', 'quality', 'teep', 'mtbf', 'mttr', 'timestamp'],
                'operations_schedule': ['id', 'line_id', 'shifts', 'shift_name', 'start_time', 'end_time', 'days', 'timestamp'],
                'pics_data': ['id', 'record_id', 'device_path', 'device_type', 'value', 'timestamp'],
                'production_lines': ['id', 'enterprise_id', 'record_id', 'location', 'business_unit', 'general_manager', 'line_name'],
                'quality_control': ['id', 'line_id', 'order_number', 'item_number', 'inspection_result', 'rejection_reason', 'accepted_quantity', 'rejection_quantity', 'timestamp'],
                's88_batch_control': ['id', 'line_id', 'batch_mixing_tank_status', 'bottler_status', 'capper_status', 'temperature_controller', 'volume_control', 'soda_recipe', 'production_parameters', 'operator_interface_status', 'process_data', 'quality_data', 'safety_status', 'timestamp']
            }
            
            self._schema_cache = schema
            return schema
            
        except Exception as e:
            logger.warning(f"Could not fetch schema: {e}")
            return self._schema_cache or {}
    
    def execute(self, sql: str, params: List = None) -> Tuple[Any, Optional[str]]:
        """Execute SQL query with improved error handling"""
        
        logger.info(f"=== EXECUTING QUERY ===")
        logger.info(f"SQL: {sql}")
        
        try:
            # Validate query safety
            is_safe, error = SQLValidator.is_safe_query(sql)
            if not is_safe:
                return None, f"Query blocked: {error}"
            
            # Execute using direct PostgreSQL connection
            conn_string = self._get_postgres_connection_string()
            from sqlalchemy import create_engine
            
            engine = create_engine(conn_string)

            with engine.connect() as connection:
                df = pd.read_sql_query(sql, connection)
                logger.info(f"Query successful: {len(df)} rows returned")
                return df, None

            engine.dispose()

        except Exception as e:
            error_msg = f"Query execution error: {str(e)}"
            logger.error(error_msg)
            return None, error_msg
    
    def _get_postgres_connection_string(self) -> str:
        """Get PostgreSQL connection string"""
        db_host = os.getenv("SUPABASE_DB_HOST")
        db_password = os.getenv("SUPABASE_DB_PASSWORD")
        
        if not db_host or not db_password:
            raise ValueError(
                "Please set SUPABASE_DB_HOST and SUPABASE_DB_PASSWORD in .env file"
            )
        
        return f"postgresql://postgres:{db_password}@{db_host}:5432/postgres"

# =============================================================================
# ENHANCED RESULT FORMATTER
# =============================================================================

class EnhancedResultFormatter:
    """Formats query results with better insights"""
    
    def __init__(self, azure_client: Optional[AzureOpenAI] = None):
        self.azure_client = azure_client
    
    def format_to_text(self, df: Any, question: str, explanation: str) -> str:
        """Convert DataFrame to insightful natural language"""
        


        if df is None or df.empty:
            return self._format_no_results(question)
        
        # Try LLM formatting for better insights
        if self.azure_client:
            try:
                return self._llm_format_with_insights(df, question, explanation)
            except Exception as e:
                logger.warning(f"LLM formatting failed: {e}. Using fallback.")
        
        # Enhanced rule-based formatting
        return self._enhanced_fallback_format(df, question, explanation)
    
    def _format_no_results(self, question: str) -> str:
        """Enhanced no results message"""
        return """🔍 **No Data Found**

I couldn't find any matching data for your query. Here are some suggestions:

**Try these alternatives:**
• Check if the specified location/line exists (e.g., "Katunayake", "Biyagama", "Line1")
• Expand your time range (e.g., "last week" instead of "last hour")
• Ask about available data: "What sites are available?" or "Show recent OEE data"
• Try a broader query: "Show current OEE for all lines"

**Available concepts I can explain:**
OEE, Availability, Performance, Quality, MTBF, MTTR"""
    
    def _llm_format_with_insights(self, df: Any, question: str, explanation: str) -> str:
        """Use LLM to generate insightful responses"""
        
        data_summary = self._create_enhanced_data_summary(df)
        
        prompt = f"""Analyze this manufacturing data and provide insightful commentary.

User Question: {question}
Query Purpose: {explanation}

Data Summary:
{data_summary}

Instructions:
- Start with a clear answer to the user's question
- Provide specific insights and analysis (not just data listing)
- Highlight notable patterns, trends, or concerns
- Use manufacturing terminology appropriately
- Be conversational but professional
- If showing OEE data, comment on performance levels (>80% excellent, 60-80% good, <60% needs improvement)
- For maintenance data, highlight any overdue items as priorities
- Keep response under 200 words

Response:"""

        response = self.azure_client.chat.completions.create(
            model=Config.AZURE_OPENAI_DEPLOYMENT,
            messages=[
                {"role": "system", "content": "You are an expert manufacturing data analyst providing actionable insights."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=30000
        )
        
        insights = response.choices[0].message.content.strip()
        
        return f"{insights}\n\n📊 **{len(df)} record(s) analyzed**"
    
    def _create_enhanced_data_summary(self, df: Any) -> str:
        """Create detailed data summary for analysis"""
        summary = []
        
        # Basic info
        summary.append(f"Records: {len(df)}")
        summary.append(f"Columns: {list(df.columns)}")
        
        # Key metrics analysis
        if 'oee' in df.columns:
            oee_avg = df['oee'].mean()
            oee_min = df['oee'].min()
            oee_max = df['oee'].max()
            summary.append(f"OEE: avg={oee_avg:.1f}%, min={oee_min:.1f}%, max={oee_max:.1f}%")
        
        if 'availability' in df.columns:
            summary.append(f"Availability: avg={df['availability'].mean():.1f}%")
        
        if 'maintenance_status' in df.columns:
            overdue_count = len(df[df['maintenance_status'].str.lower() == 'overdue'])
            summary.append(f"Maintenance: {overdue_count} overdue items")
            
        if 'next_maintenance_date' in df.columns:
            overdue_count = len(df[df['next_maintenance_date'] < pd.Timestamp.now()])
            summary.append(f"Maintenance: {overdue_count} items with overdue maintenance dates")
        # Time range
        if 'timestamp' in df.columns:
            summary.append(f"Time range: {df['timestamp'].min()} to {df['timestamp'].max()}")
        
        # Sample data
        summary.append("\nSample records:")
        summary.append(df.head(3).to_string(index=False))
        
        return "\n".join(summary)
    
    def _enhanced_fallback_format(self, df: Any, question: str, explanation: str) -> str:
        """Enhanced rule-based formatting with insights"""
        
        text = ""
        
        # Single record - detailed analysis
        if len(df) == 1:
            text += self._format_single_record_insights(df.iloc[0], question)
        
        # Multiple records - trend analysis
        elif len(df) <= 20:
            text += self._format_multiple_records_insights(df, question)
        
        # Large dataset - summary insights
        else:
            text += self._format_large_dataset_insights(df, question)
        
        text += f"\n\n*{explanation}*"
        return text
    
    def _format_single_record_insights(self, record: Any, question: str) -> str:
        """Format single record with insights"""
        text = "📈 **Current Status:**\n\n"
        
        # OEE Analysis
        if 'oee' in record.index and pd.notna(record['oee']):
            oee = record['oee']
            if oee >= 80:
                performance_comment = "Excellent performance! 🟢"
            elif oee >= 60:
                performance_comment = "Good performance 🟡"
            else:
                performance_comment = "Performance needs attention 🔴"
            
            text += f"**OEE: {oee:.1f}%** - {performance_comment}\n\n"
            
            # Breakdown analysis
            if 'availability' in record.index:
                text += f"• Availability: {record['availability']:.1f}%\n"
            if 'performance' in record.index:
                text += f"• Performance: {record['performance']:.1f}%\n"
            if 'quality' in record.index:
                text += f"• Quality: {record['quality']:.1f}%\n"
            text += "\n"
        
        # Location info
        location_parts = []
        for col in ['line_name', 'location', 'area', 'asset_name']:
            if col in record.index and pd.notna(record[col]):
                location_parts.append(str(record[col]))
        
        if location_parts:
            text += f"📍 **Location:** {' | '.join(location_parts)}\n\n"
        
        # Timestamp
        if 'timestamp' in record.index and pd.notna(record['timestamp']):
            text += f"🕐 **As of:** {record['timestamp']}\n"
        
        return text
    
    def _format_multiple_records_insights(self, df: Any, question: str) -> str:
        """Format multiple records with trend insights"""
        text = f"📊 **Analysis of {len(df)} Records:**\n\n"
        
        # OEE trend analysis
        if 'oee' in df.columns:
            avg_oee = df['oee'].mean()
            std_oee = df['oee'].std()
            
            text += f"**Average OEE: {avg_oee:.1f}%**\n"
            
            if std_oee > 10:
                text += "⚠️ High variability detected - investigate inconsistencies\n"
            elif std_oee < 5:
                text += "✅ Consistent performance across time period\n"
            
            # Performance categorization
            excellent = len(df[df['oee'] >= 80])
            good = len(df[(df['oee'] >= 60) & (df['oee'] < 80)])
            poor = len(df[df['oee'] < 60])
            
            text += f"\n**Performance Distribution:**\n"
            text += f"• Excellent (≥80%): {excellent} records\n"
            text += f"• Good (60-79%): {good} records\n"
            text += f"• Needs Attention (<60%): {poor} records\n\n"
        
        # Time trend
        if 'timestamp' in df.columns:
            text += f"📅 **Period:** {df['timestamp'].min().strftime('%Y-%m-%d %H:%M')} to {df['timestamp'].max().strftime('%Y-%m-%d %H:%M')}\n"
        
        return text
    
    def _format_large_dataset_insights(self, df: Any, question: str) -> str:
        """Format large dataset with statistical insights"""
        text = f"📈 **Statistical Analysis ({len(df)} records):**\n\n"
        
        numeric_cols = df.select_dtypes(include=['float64', 'int64']).columns
        numeric_cols = [col for col in numeric_cols if col != 'id']
        
        for col in numeric_cols[:4]:
            mean_val = df[col].mean()
            median_val = df[col].median()
            text += f"**{col.replace('_', ' ').title()}:** avg={mean_val:.1f}, median={median_val:.1f}\n"
        
        if 'timestamp' in df.columns:
            text += f"\n📅 **Time Span:** {df['timestamp'].min()} to {df['timestamp'].max()}\n"
        
        return text

# =============================================================================
# ENHANCED VISUALIZATION GENERATOR
# =============================================================================

# Replace the EnhancedVisualizationGenerator class with this updated version

class EnhancedVisualizationGenerator:
    """Enhanced visualization with better charts including pie charts"""
    
    @staticmethod
    def should_visualize(question: str, df: Any) -> bool:
        """Smarter visualization detection"""
        
        if df is None or (hasattr(df, 'empty') and df.empty):
            return False
        
        viz_keywords = ['trend', 'visualize', 'plot', 'chart', 'graph', 'compare', 'over time', 'pie', 'distribution']
        has_viz_keyword = any(keyword in question.lower() for keyword in viz_keywords)
        
        # Auto-visualize if multiple records with time data
        has_time_series = 'timestamp' in df.columns and len(df) > 1
        
        return has_viz_keyword or has_time_series
    
    @staticmethod
    def generate_chart(df: Any, question: str):
        """Generate enhanced visualizations"""
       
        try:
            # Set style
            plt.style.use('default')
            
            fig, ax = plt.subplots(figsize=(12, 8))
            
            # Detect pie chart request
            if 'pie' in question.lower():
                return EnhancedVisualizationGenerator._create_pie_chart(df, question, fig, ax)
            
            # Time series visualization
            elif 'timestamp' in df.columns and len(df) > 1:
                return EnhancedVisualizationGenerator._create_time_series_chart(df, question, fig, ax)
            
            # Comparison charts
            elif any(col in df.columns for col in ['site', 'line_name', 'area', 'location']):
                return EnhancedVisualizationGenerator._create_comparison_chart(df, question, fig, ax)
            
            # Distribution charts
            else:
                return EnhancedVisualizationGenerator._create_distribution_chart(df, question, fig, ax)
                
        except Exception as e:
            logger.error(f"Visualization error: {e}")
            return None
    
    @staticmethod
    def _create_pie_chart(df: Any, question: str, fig, ax):
        """Create pie chart for categorical data"""
        
        # Find the best columns for pie chart
        # Priority: categorical columns with reasonable number of categories
        categorical_cols = ['maintenance_status', 'rejection_reason', 'line_name', 
                           'location', 'area', 'site', 'order_status', 'inspection_result']
        
        # Find which categorical column exists in df
        label_col = None
        for col in categorical_cols:
            if col in df.columns:
                label_col = col
                break
        
        # If no categorical column found, try to find any string column
        if not label_col:
            for col in df.columns:
                if df[col].dtype == 'object' and col not in ['timestamp', 'id']:
                    label_col = col
                    break
        
        if not label_col:
            # Fallback to another chart type
            return EnhancedVisualizationGenerator._create_comparison_chart(df, question, fig, ax)
        
        # Find numeric column for values (or use count)
        numeric_cols = df.select_dtypes(include=['float64', 'int64']).columns
        numeric_cols = [col for col in numeric_cols if col not in ['id', 'line_id', 'asset_id']]
        
        if len(numeric_cols) > 0:
            # Use first numeric column for values
            value_col = numeric_cols[0]
            
            # Aggregate data
            if len(df) > 1:
                pie_data = df.groupby(label_col)[value_col].sum()
            else:
                pie_data = df.set_index(label_col)[value_col]
        else:
            # Count occurrences
            pie_data = df[label_col].value_counts()
        
        # Limit to top 10 categories for readability
        if len(pie_data) > 10:
            pie_data = pie_data.nlargest(10)
            title_suffix = " (Top 10)"
        else:
            title_suffix = ""
        
        # Create pie chart with enhanced styling
        colors = plt.cm.Set3(range(len(pie_data)))
        wedges, texts, autotexts = ax.pie(
            pie_data.values, 
            labels=pie_data.index,
            autopct='%1.1f%%',
            colors=colors,
            startangle=90,
            textprops={'fontsize': 10}
        )
        
        # Enhance text readability
        for autotext in autotexts:
            autotext.set_color('white')
            autotext.set_fontweight('bold')
        
        # Add legend with values
        legend_labels = [f"{label}: {value:.1f}" for label, value in zip(pie_data.index, pie_data.values)]
        ax.legend(legend_labels, loc="center left", bbox_to_anchor=(1, 0, 0.5, 1))
        
        title = question[:80] + '...' if len(question) > 80 else question
        ax.set_title(f"{title}{title_suffix}", pad=20)
        
        plt.tight_layout()
        return fig
    
    @staticmethod
    def _create_time_series_chart(df: Any, question: str, fig, ax):
        """Create time series chart"""
        df_sorted = df.sort_values('timestamp')
        
        # Plot OEE components if available
        if 'oee' in df.columns:
            ax.plot(df_sorted['timestamp'], df_sorted['oee'], 
                   marker='o', linewidth=2, label='OEE', color='#2E86AB')
            
            if 'availability' in df.columns:
                ax.plot(df_sorted['timestamp'], df_sorted['availability'], 
                       marker='s', alpha=0.7, label='Availability', color='#A23B72')
                
            if 'performance' in df.columns:
                ax.plot(df_sorted['timestamp'], df_sorted['performance'], 
                       marker='^', alpha=0.7, label='Performance', color='#F18F01')
                
            if 'quality' in df.columns:
                ax.plot(df_sorted['timestamp'], df_sorted['quality'], 
                       marker='d', alpha=0.7, label='Quality', color='#C73E1D')
            
            # Add target line at 80%
            ax.axhline(y=80, color='green', linestyle='--', alpha=0.5, label='Target (80%)')
            
            ax.set_ylabel('Percentage (%)')
            ax.set_ylim(0, 100)
        
        else:
            # Plot other numeric columns
            numeric_cols = df_sorted.select_dtypes(include=['float64', 'int64']).columns
            numeric_cols = [col for col in numeric_cols if col != 'id']
            
            colors = ['#2E86AB', '#A23B72', '#F18F01', '#C73E1D']
            for i, col in enumerate(numeric_cols[:4]):
                ax.plot(df_sorted['timestamp'], df_sorted[col], 
                       marker='o', label=col.replace('_', ' ').title(), 
                       color=colors[i % len(colors)])
            
            ax.set_ylabel('Value')
        
        ax.set_xlabel('Time')
        ax.set_title(question[:80] + '...' if len(question) > 80 else question)
        ax.legend()
        ax.grid(True, alpha=0.3)
        
        # Format x-axis
        fig.autofmt_xdate()
        
        plt.tight_layout()
        return fig
    
    @staticmethod
    def _create_comparison_chart(df: Any, question: str, fig, ax):
        """Create comparison bar chart"""
        # Find grouping column
        group_cols = ['site', 'line_name', 'area', 'location']
        group_col = next((col for col in group_cols if col in df.columns), None)
        
        if not group_col:
            return None
        
        # Find value column (prefer OEE)
        if 'oee' in df.columns:
            value_col = 'oee'
            ax.set_ylabel('OEE (%)')
            # Add color coding based on performance
            colors = ['red' if x < 60 else 'orange' if x < 80 else 'green' for x in df[value_col]]
        else:
            numeric_cols = df.select_dtypes(include=['float64', 'int64']).columns
            numeric_cols = [col for col in numeric_cols if col != 'id']
            value_col = numeric_cols[0] if numeric_cols else None
            colors = '#2E86AB'
        
        if value_col:
            # Group and sort data
            if len(df) > 1:
                grouped = df.groupby(group_col)[value_col].mean().sort_values(ascending=False)
            else:
                grouped = df.set_index(group_col)[value_col]
            
            bars = ax.bar(grouped.index, grouped.values, color=colors)
            
            # Add value labels on bars
            for bar in bars:
                height = bar.get_height()
                ax.text(bar.get_x() + bar.get_width()/2., height,
                       f'{height:.1f}', ha='center', va='bottom')
            
            ax.set_xlabel(group_col.replace('_', ' ').title())
            ax.set_ylabel(value_col.replace('_', ' ').title())
            
            # Add reference line for OEE
            if value_col == 'oee':
                ax.axhline(y=80, color='green', linestyle='--', alpha=0.7, label='Target (80%)')
                ax.legend()
        
        ax.set_title(question[:80] + '...' if len(question) > 80 else question)
        plt.xticks(rotation=45, ha='right')
        plt.tight_layout()
        return fig
    
    @staticmethod
    def _create_distribution_chart(df: Any, question: str, fig, ax):
        """Create distribution chart"""
        numeric_cols = df.select_dtypes(include=['float64', 'int64']).columns
        numeric_cols = [col for col in numeric_cols if col != 'id']
        
        if len(numeric_cols) > 0:
            main_col = numeric_cols[0]
            
            # Histogram with KDE
            df[main_col].hist(bins=min(20, len(df)//2), alpha=0.7, ax=ax, color='#2E86AB')
            ax.set_xlabel(main_col.replace('_', ' ').title())
            ax.set_ylabel('Frequency')
            
            # Add mean line
            mean_val = df[main_col].mean()
            ax.axvline(mean_val, color='red', linestyle='--', 
                      label=f'Mean: {mean_val:.1f}')
            ax.legend()
        
        ax.set_title(question[:80] + '...' if len(question) > 80 else question)
        plt.tight_layout()
        return fig
# =============================================================================
# MAIN STREAMLIT APPLICATION
# =============================================================================

def main():
    """Main Streamlit application with improvements"""
    
    st.set_page_config(
        page_title="Improved Manufacturing Chatbot",
        page_icon="🏭",
        layout="wide"
    )
    
    # Session tracking
    if 'session_id' not in st.session_state:
        import uuid
        st.session_state.session_id = str(uuid.uuid4())[:8]
        logger.info(f"New session: {st.session_state.session_id}")
    
    st.title("🏭 Manufacturing Data Chatbot")
    st.markdown("**Clean SQL Generation • Better Insights • Enhanced Visualizations**")
    
    # Initialize clients
    supabase, azure_client = init_clients()
    
    # Initialize improved components
    executor = QueryExecutor(supabase)
    translator = ImprovedNLToSQLTranslator(azure_client, executor)
    formatter = EnhancedResultFormatter(azure_client)
    viz_generator = EnhancedVisualizationGenerator()
    
    # Enhanced sidebar
    with st.sidebar:
        st.header("⚙️ Configuration")
        
        # Connection status
        st.subheader("🔗 Connection Status")
        st.success("✅ Supabase Connected")
        if azure_client:
            st.success("✅ Azure OpenAI Connected")
        else:
            st.warning("⚠️ Azure OpenAI Not Available")
        
        # Database schema
        with st.expander("📋 Database Schema"):
            schema = executor.get_schema_info()
            for table, columns in schema.items():
                st.write(f"**{table}:**")
                st.caption(", ".join(columns))
        
        st.divider()
        
        # Filters
        st.subheader("🔍 Filters")
        filter_site = st.selectbox("Site", ["All", "Katunayake", "Biyagama"])
        filter_line = st.text_input("Line (e.g., Line1)")
        
        context = {}
        if filter_site != "All":
            context['site'] = filter_site
        if filter_line:
            context['line'] = filter_line
        
        st.divider()
        
        # Example questions
        st.subheader("💡 Example Questions")
        
        col1, col2 = st.columns(2)
        
        with col1:
            st.markdown("**📊 Data Queries:**")
            example_queries = [
                "Current OEE in Katunayake",
                "Show OEE trends last 24 hours",
                "Which machines need maintenance?",
                "Quality issues in Biyagama Press",
            ]
            
            for query in example_queries:
                if st.button(query, key=f"example_{query}"):
                    st.session_state.example_query = query
        
        with col2:
            st.markdown("**🤔 Ask Me About:**")
            st.markdown("""
            • What is OEE?
            • Explain availability
            • Define MTBF and MTTR
            • Performance metrics
            """)
        
        st.divider()
        
        # Clear history
        if st.button("🗑️ Clear Chat History"):
            st.session_state.messages = []
            st.rerun()
    
    # Initialize chat history
    if "messages" not in st.session_state:
        st.session_state.messages = []
    
    # Display chat history
    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])
            
            # Show data table
            if "dataframe" in message:
                with st.expander("📊 View Data Table"):
                    st.dataframe(message["dataframe"], use_container_width=True)
            
            # Show chart
            if "chart" in message:
                st.pyplot(message["chart"])
            
            # Show SQL
            if "sql" in message:
                with st.expander("🔍 Generated SQL"):
                    st.code(message["sql"], language="sql")
    
    # Handle example query selection
    if hasattr(st.session_state, 'example_query'):
        prompt = st.session_state.example_query
        del st.session_state.example_query
    else:
        prompt = st.chat_input("Ask me about your manufacturing data...")
    
    # Process user input
    if prompt:
        logger.info(f"Processing query: {prompt}")
        
        # Add user message
        st.session_state.messages.append({"role": "user", "content": prompt})
        
        with st.chat_message("user"):
            st.markdown(prompt)
        
        # Generate assistant response
        with st.chat_message("assistant"):
            with st.spinner("🤔 Analyzing your question..."):
                # Translate query
                translation = translator.translate(prompt, context)
                
                # Handle conceptual questions
                if translation.get('is_conceptual'):
                    answer = translation.get('answer', 'No answer available.')
                    st.markdown(answer)
                    st.session_state.messages.append({
                        "role": "assistant",
                        "content": answer
                    })
                
                # Handle errors
                elif 'error' in translation:
                    error_msg = f"❌ {translation['error']}"
                    st.error(translation['error'])
                    st.session_state.messages.append({
                        "role": "assistant", 
                        "content": error_msg
                    })
                
                # Handle SQL queries
                else:
                    sql = translation['sql']
                    explanation = translation.get('explanation', '')
                    
                    # Show generated SQL
                    with st.expander("🔍 Generated SQL"):
                        st.code(sql, language="sql")
                        st.caption(f"Query purpose: {explanation}")
                    
                    # Execute query
                    with st.spinner("⚙️ Executing query..."):
                        df, error = executor.execute(sql)
                    
                    if error:
                        error_msg = f"❌ {error}"
                        st.error(error)
                        st.session_state.messages.append({
                            "role": "assistant",
                            "content": error_msg,
                            "sql": sql
                        })
                    else:
                        # Format results with insights
                        insights = formatter.format_to_text(df, prompt, explanation)
                        st.markdown(insights)
                        
                        # Show data table
                        if df is not None and not df.empty:
                            with st.expander(f"📊 View Data Table ({len(df)} rows)"):
                                st.dataframe(df, use_container_width=True)
                        
                        # Generate visualization
                        chart = None
                        if viz_generator.should_visualize(prompt, df):
                            with st.spinner("📈 Creating visualization..."):
                                chart = viz_generator.generate_chart(df, prompt)
                                if chart:
                                    st.pyplot(chart)
                        
                        # Save to history
                        message_data = {
                            "role": "assistant",
                            "content": insights,
                            "sql": sql
                        }
                        
                        if df is not None and not df.empty:
                            message_data["dataframe"] = df
                        
                        if chart:
                            message_data["chart"] = chart
                        
                        st.session_state.messages.append(message_data)

if __name__ == "__main__":
    main()
