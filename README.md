# 🚦 Semáforo Inteligente — Fase 3
<img width="1622" height="1001" alt="semaforo" src="https://github.com/user-attachments/assets/291cfaec-9f7c-4624-ac59-a3a894b89719" />

Simulación web de una red de tráfico inteligente para **Lomas del Cacique**. El sistema representa ocho intersecciones conectadas, adapta los ciclos semafóricos a la congestión y reacciona ante incidentes, cruces peatonales y vehículos de emergencia. También puede recibir eventos de sensores ESP32 mediante MQTT.

## Características

- **Red de 8 intersecciones** conectadas en una cuadrícula vial.
- **Semáforos adaptativos**: la duración del verde cambia según las colas detectadas por dirección.
- **Ruteo inteligente con Dijkstra**: calcula rutas de menor costo y evita nodos bloqueados o congestionados.
- **Gestión de incidentes**: bloquea temporalmente la intersección afectada, alerta a los nodos vecinos y redirige el tráfico.
- **Prioridad de emergencia** para ambulancias, tanto simuladas como detectadas por RFID.
- **Control peatonal** con cruces seguros coordinados con la fase semafórica.
- **Sensores visuales** por dirección y cámara central para cada intersección.
- **Panel de monitoreo** con métricas de vehículos, espera promedio, emergencias, estados de semáforos e historial de tráfico.
- **Modo nocturno**, ola verde y controles manuales para inyectar vehículos, peatones e incidentes.
- **Integración MQTT** con ESP32 a través del broker público HiveMQ.
<img width="944" height="753" alt="image" src="https://github.com/user-attachments/assets/7bf437f6-708a-4f6e-9da1-eb1986ad1cf9" />

## Tecnologías

- HTML5
- CSS3
- JavaScript vanilla
- MQTT.js 4.3.7
- HiveMQ WebSocket Broker

## Ejecutar la simulación

No se requiere instalación ni proceso de compilación.

1. Clona el repositorio:

   ```bash
   git clone https://github.com/OscarALR/SemaforoInteligenteF3.git
   ```

2. Abre `index.html` en un navegador moderno.

   Para una experiencia más consistente, puedes servirlo localmente:

   ```bash
   python -m http.server 8000
   ```

3. Visita `http://localhost:8000`.

## Controles principales

| Control | Acción |
| --- | --- |
| 🟢 Activar Ola Verde | Sincroniza los semáforos en el eje este-oeste de forma escalonada. |
| 🔴 Desactivar Ola Verde | Detiene la sincronización de la ola verde. |
| ⏸️ Pausar Generación de Autos | Pausa o reanuda la creación automática de vehículos. |
| 🌙 Modo Nocturno | Alterna el funcionamiento nocturno; los nodos se reactivan al detectar tránsito. |
| 🚑 Enviar Ambulancia | Genera una ambulancia con prioridad de paso. |
| 🚨 Simular choque | Bloquea una intersección y activa la coordinación de desvíos. |
| 🚶 Agregar peatón | Solicita un cruce peatonal seguro en la intersección elegida. |
| ＋ Agregar vehículo | Inserta manualmente un auto o camión desde una entrada y carril seleccionados. |

## Integración MQTT / ESP32
<img width="1929" height="1171" alt="image" src="https://github.com/user-attachments/assets/b21b6710-92f6-49d6-bced-c1f6b2914f46" />

La aplicación se conecta mediante WebSocket a:

```text
wss://broker.hivemq.com:8884/mqtt
```

Se suscribe al prefijo:

```text
lomasdelcacique-unah-2026/fase3/sensor/#
```

Eventos reconocidos:

| Sufijo del tópico | Payload esperado | Efecto |
| --- | --- | --- |
| `/distancia-este` | Distancia en centímetros | Actualiza la barra de proximidad; si es menor de 20 cm, crea un vehículo. |
| `/ambulancia` | Cualquier valor | Registra una lectura RFID y despliega una ambulancia prioritaria. |
| `/este`, `/oeste` | Cualquier valor | Ingresa un vehículo desde el eje horizontal. |
| `/norte-int1`, `/sur-int1` | Cualquier valor | Ingresa un vehículo desde el eje vertical de la intersección 1. |
| `/incidente` | Número de intersección o `aleatorio` | Activa un incidente en el nodo indicado. |
| `/incidente-limpiar` | Cualquier valor | Despeja todos los incidentes activos. |

> El broker MQTT es público. Para una implementación de producción, utiliza credenciales, TLS y un broker privado o administrado.

## Estructura del proyecto

```text
SemaforoInteligenteF3/
├── index.html       # Escenario, controles y paneles de monitoreo
├── semaforo.css     # Diseño visual de la cuadrícula y dashboard
└── script.js        # Simulación, semáforos, ruteo, sensores y MQTT
```

## Lógica de coordinación

Cada intersección mantiene sus propios estados y colas de tráfico. Al crear o redirigir un vehículo, el sistema usa Dijkstra sobre el grafo vial y asigna un costo mayor a los nodos con mayor congestión. Si hay un incidente, sus aristas se consideran no transitables; los nodos vecinos reciben una alerta y priorizan la salida que facilita el desvío.

Los ciclos semafóricos alternan los pares norte-sur y este-oeste. El tiempo de verde se ajusta según la cantidad de vehículos esperando, con prioridad adicional para peatones, incidentes cercanos y ambulancias.

## Posibles mejoras

- Persistir estadísticas e incidentes en una base de datos.
- Añadir autenticación y tópicos MQTT por dispositivo.
- Incorporar mapas reales, límites de velocidad y más tipos de vehículos.
- Agregar pruebas automatizadas para ruteo, prioridad y ciclos semafóricos.

## Autoría
Subido en GitHub Pages: https://oscaralr.github.io/SemaforoInteligenteF3/

Para clonar el proyecto desarrollado en Wokwi, pueden copiar directamente del siguiente link: https://wokwi.com/projects/470595757282265089

Desarrollado por [OscarALR](https://github.com/OscarALR) como proyecto universitario de simulación de tráfico inteligente.
