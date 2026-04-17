variable "app_task_container_image" {
  description = "Docker Image to be deployed for the simulator"
  type        = string
  default     = "192351105085.dkr.ecr.eu-west-1.amazonaws.com/simulator:latest"
}

variable "app_task_environment" {
  description = "Environment name"
  type        = string
  default     = "sdbx"
}

variable "cp_ws_list" {
  description = "List of charge point IDs with associated WebSocket URLs"
  type = list(object({
    cp_id  = string
    ws_url = string
    name   = optional(string)
  }))
  default = [
    { cp_id = "FR*ORV*ROO10", ws_url = "wss://proxy.ocpp-proxy.test.oreve.com" },
    { cp_id = "FR*ORV*A0015", ws_url = "wss://server.16.ocpp.stg.oreve.com" },
    { cp_id = "FR*ORV*A0016", ws_url = "wss://ocpp.oreve.com" },
    { cp_id = "CS*SIMULATOR*1", ws_url = "wss://cpc.eu-stable.uat.charge.ampeco.tech/obornes/CS%2ASIMULATOR%2A1" },
    { cp_id = "FR*ORV*B0201", ws_url = "wss://proxy.ocpp-proxy.test.oreve.com" },
    { cp_id = "FR*ONCE*B8890", ws_url = "wss://server.16.ocpp.stg.oreve.com", name = "FR-ONC-B8890" },
    { cp_id = "FR*ONCE*B8891", ws_url = "wss://server.16.ocpp.stg.oreve.com", name = "FR-ONC-B8891" },
    { cp_id = "FR*ONCE*A0014", ws_url = "wss://server.16.ocpp.stg.oreve.com" },
  ]
}