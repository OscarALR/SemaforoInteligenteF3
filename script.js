/* Simulador de tráfico para la cuadrícula de 8 nodos definida en index.html. */

const NUM_NODOS = 8;
const DIRECCIONES = ['norte', 'sur', 'este', 'oeste'];
const ESTADO_INICIAL = { norte: 'verde', sur: 'verde', este: 'rojo', oeste: 'rojo' };

const estadisticas = {
  procesados: 0,
  emergencias: 0,
  esperaAcumulada: 0,
  autosConEspera: 0,
};


const intersecciones = Array.from({ length: NUM_NODOS }, (_, indice) => ({
  indice,
  parActivo: 'NS',
  fase: 'verde',
  restante: 8,
  modoNocturno: false,
  hayTrafico: false,
  emergencia: null,
  peaton: null,
  semaforos: { ...ESTADO_INICIAL },
  // Conteo REAL de autos detenidos por dirección (no solo "hay o no hay"),
  // usado para que el verde responda a la cantidad de tráfico de verdad.
  colaPorDireccion: { norte: 0, sur: 0, este: 0, oeste: 0 },
}));

let vehiculos = [];
let siguienteVehiculo = 1;
let spawnPausado = false;
let olaVerdeActiva = false;
let historialTrafico = [];
const INTERVALO_MOVIMIENTO_MS = 50;
const VELOCIDAD_AUTO = 0.45;
const VELOCIDAD_EMERGENCIA = 0.8;
// La línea de alto queda antes de la cebra, no dentro de la intersección.
const DISTANCIA_ANTES_CEBRA_PX = 55;
const DISTANCIA_MINIMA_AUTOS_PX = 34;
const RADIO_SENSOR_CENTRAL_PX = 95;

const elemento = (id) => document.getElementById(id);
const nodoElemento = (indice) => elemento(`nodo-${indice}`);
const esVertical = (direccion) => direccion === 'norte' || direccion === 'sur';
const parDe = (direccion) => esVertical(direccion) ? 'NS' : 'EW';

/* ===================================================
   FASE 3 — GRAFO DE LA CUADRÍCULA Y COORDINACIÓN ENTRE NODOS
   Fila superior: nodos 0-1-2-3.  Fila inferior: nodos 4-5-6-7.
   Columnas verticales: (0,4) (1,5) (2,6) (3,7).
=================================================== */
const GRAFO = {
  0: { este: 1, sur: 4 },
  1: { oeste: 0, este: 2, sur: 5 },
  2: { oeste: 1, este: 3, sur: 6 },
  3: { oeste: 2, sur: 7 },
  4: { norte: 0, este: 5 },
  5: { norte: 1, oeste: 4, este: 6 },
  6: { norte: 2, oeste: 5, este: 7 },
  7: { norte: 3, oeste: 6 },
};

// Carriles paralelos disponibles para cada tipo de movimiento. El motor
// visual sólo anima trayectos rectos, así que el algoritmo elige entre
// estas alternativas en vez de generar giros dentro de una misma ruta.
const CARRILES_HORIZONTALES = [[0, 1, 2, 3], [4, 5, 6, 7]];
const CARRILES_VERTICALES = [[0, 4], [1, 5], [2, 6], [3, 7]];

// nodo -> { creado, origen, temporizador }
const incidentes = new Map();
const historialIncidentes = [];

function opuesta(direccion) {
  return { norte: 'sur', sur: 'norte', este: 'oeste', oeste: 'este' }[direccion];
}

// Cuenta cuántos autos están detenidos justo antes de cada nodo. Esta es
// la "información" que los semáforos comparten para decidir rutas: no
// hace falta que un auto choque para que el sistema reaccione, basta con
// que se esté formando una cola.
function medirColas() {
  const colas = {};
  intersecciones.forEach((interseccion) => { colas[interseccion.indice] = 0; });
  vehiculos.forEach((vehiculo) => {
    if (!vehiculo.detenido) return;
    const nodoObjetivo = vehiculo.ruta[vehiculo.siguienteControl];
    if (nodoObjetivo !== undefined) colas[nodoObjetivo] = (colas[nodoObjetivo] || 0) + 1;
  });
  return colas;
}

// Igual que medirColas, pero desglosado por dirección de llegada. Esto es
// lo que le permite al semáforo saber no solo "hay alguien esperando" sino
// "hay 4 autos esperando desde el norte y 0 desde el sur", para que el
// verde responda a la cantidad real de tráfico en vez de a un simple sí/no.
function medirColasPorDireccion() {
  const colas = {};
  intersecciones.forEach((interseccion) => {
    colas[interseccion.indice] = { norte: 0, sur: 0, este: 0, oeste: 0 };
  });
  vehiculos.forEach((vehiculo) => {
    if (!vehiculo.detenido) return;
    const nodoObjetivo = vehiculo.ruta[vehiculo.siguienteControl];
    if (nodoObjetivo === undefined || !colas[nodoObjetivo]) return;
    const anterior = vehiculo.siguienteControl ? vehiculo.ruta[vehiculo.siguienteControl - 1] : null;
    const direccionLlegada = anterior === null ? vehiculo.direccion : direccionEntre(anterior, nodoObjetivo);
    colas[nodoObjetivo][direccionLlegada] += 1;
  });
  return colas;
}

// Costo de cruzar de un nodo a otro: infinito si cualquiera de los dos
// extremos tiene un incidente activo, y creciente según la cola de autos
// esperando en el nodo destino.
function pesoArista(a, b, colas) {
  if (incidentes.has(a) || incidentes.has(b)) return Infinity;
  const congestion = colas[b] || 0;
  return 1 + congestion * 1.5;
}

// Dijkstra genérico sobre el grafo de la cuadrícula (8 nodos, así que un
// barrido simple sin cola de prioridad es más que suficiente). Se deja
// disponible como utilidad general para calcular la ruta más barata entre
// dos intersecciones cualesquiera, más allá de la selección de carril.
function dijkstra(origen, destino, colas = medirColas()) {
  const nodos = Object.keys(GRAFO).map(Number);
  const dist = {}; const previo = {}; const visitado = new Set();
  nodos.forEach((n) => { dist[n] = Infinity; });
  dist[origen] = 0;

  while (visitado.size < nodos.length) {
    let actual = null;
    nodos.forEach((n) => {
      if (!visitado.has(n) && (actual === null || dist[n] < dist[actual])) actual = n;
    });
    if (actual === null || dist[actual] === Infinity) break;
    visitado.add(actual);
    if (actual === destino) break;

    Object.values(GRAFO[actual]).forEach((vecino) => {
      if (visitado.has(vecino)) return;
      const peso = pesoArista(actual, vecino, colas);
      if (dist[actual] + peso < dist[vecino]) {
        dist[vecino] = dist[actual] + peso;
        previo[vecino] = actual;
      }
    });
  }

  if (dist[destino] === Infinity) return null;
  const ruta = [destino];
  let paso = destino;
  while (paso !== origen) {
    paso = previo[paso];
    ruta.unshift(paso);
  }
  return { ruta, costo: dist[destino] };
}

function costoDeCarril(carril, colas) {
  let costo = 0;
  for (let i = 0; i < carril.length - 1; i += 1) costo += pesoArista(carril[i], carril[i + 1], colas);
  return costo;
}

// Elige, entre los carriles paralelos disponibles para una dirección, el
// de menor costo (evita nodos bloqueados y prioriza los menos
// congestionados). Si el carril preferido ya es el más barato, se
// respeta tal cual. Esta es la pieza que "minimiza el tráfico": cada
// vehículo nuevo consulta el estado compartido de la red antes de entrar.
function elegirMejorCarril(direccion, indicePreferido) {
  const colas = medirColas();
  const grupo = esVertical(direccion) ? CARRILES_VERTICALES : CARRILES_HORIZONTALES;
  const invertir = direccion === 'oeste' || direccion === 'norte';

  const candidatos = grupo.map((carril, i) => {
    const ordenado = invertir ? [...carril].reverse() : carril;
    return { i, ruta: ordenado, costo: costoDeCarril(ordenado, colas) };
  });

  const mejor = candidatos.reduce((a, b) => (b.costo < a.costo ? b : a));
  const preferido = candidatos[indicePreferido] || candidatos[0];

  if (Number.isFinite(mejor.costo) && mejor.costo < preferido.costo) {
    registrarEventoIncidente(
      `🧭 Coordinación entre semáforos: se desvía tráfico del carril ${preferido.i} al ${mejor.i} ` +
      `(costo ${Number.isFinite(preferido.costo) ? preferido.costo.toFixed(1) : '∞'} → ${mejor.costo.toFixed(1)}).`,
      'info',
    );
    return mejor.ruta;
  }
  return Number.isFinite(preferido.costo) ? preferido.ruta : mejor.ruta;
}

function registrarEventoIncidente(mensaje, tipo = 'alerta') {
  const hora = new Date().toLocaleTimeString('es-HN', { hour12: false });
  historialIncidentes.unshift({ mensaje: `[${hora}] ${mensaje}`, tipo });
  if (historialIncidentes.length > 40) historialIncidentes.length = 40;
  const contenedor = elemento('logIncidentes');
  if (contenedor) {
    contenedor.innerHTML = historialIncidentes
      .map((evento) => `<div class="log-incidente-item ${evento.tipo}">${evento.mensaje}</div>`)
      .join('');
  }
}

function actualizarResumenIncidentes() {
  const resumen = elemento('resumenIncidentes');
  if (!resumen) return;
  resumen.textContent = incidentes.size
    ? `⚠️ ${incidentes.size} incidente(s) activo(s): INT-${[...incidentes.keys()].map((n) => n + 1).join(', INT-')}`
    : 'Sin incidentes activos.';
}

// Al ocurrir un choque, el nodo se bloquea por completo (todos los
// semáforos apagados) y notifica a sus vecinos directos en el grafo, que
// priorizan la dirección que ayuda a drenar el desvío ("comparten
// información y se enteran del sitio específico del evento").
function activarIncidente(indice, origen = 'manual') {
  if (indice < 0 || indice >= NUM_NODOS || incidentes.has(indice)) return;

  const registro = { creado: Date.now(), origen };
  incidentes.set(indice, registro);
  registro.temporizador = setTimeout(() => despejarIncidente(indice), 25000);

  const interseccion = intersecciones[indice];
  interseccion.fase = 'apagado';
  aplicarSemaforos(interseccion);
  nodoElemento(indice)?.classList.add('bloqueada');

  registrarEventoIncidente(
    `🚨 Incidente en INT-${indice + 1} (origen: ${origen}). Bloqueando nodo y notificando a la red…`, 'alerta',
  );

  Object.entries(GRAFO[indice] || {}).forEach(([direccion, vecino]) => {
    intersecciones[vecino].alertaVecina = { origenIncidente: indice, direccionEscape: opuesta(direccion) };
    registrarEventoIncidente(
      `↳ INT-${vecino + 1} recibió la alerta: dará prioridad de verde hacia ${opuesta(direccion)}.`, 'info',
    );
  });

  actualizarResumenIncidentes();
}

function despejarIncidente(indice) {
  if (!incidentes.has(indice)) return;
  clearTimeout(incidentes.get(indice)?.temporizador);
  incidentes.delete(indice);

  intersecciones.forEach((interseccion) => {
    if (interseccion.alertaVecina?.origenIncidente === indice) interseccion.alertaVecina = null;
  });

  nodoElemento(indice)?.classList.remove('bloqueada');
  reactivarNodoNocturno(intersecciones[indice]);
  registrarEventoIncidente(`✅ Incidente en INT-${indice + 1} despejado. La red vuelve a operación normal.`, 'info');
  actualizarResumenIncidentes();
}

function despejarTodosLosIncidentes() {
  [...incidentes.keys()].forEach(despejarIncidente);
}

// Los semáforos Norte/Sur sobresalen de la celda de la intersección.  Sin una
// capa superior, las manzanas vecinas pueden dibujarse encima de ellos.
function asegurarVisibilidadSemaforos() {
  document.querySelectorAll('.interseccion').forEach((interseccion) => {
    interseccion.style.zIndex = '20';
    interseccion.style.overflow = 'visible';
  });
  document.querySelectorAll('.semaforo').forEach((semaforo) => {
    semaforo.style.zIndex = '100';
  });
}

function estadoDelPar(interseccion, direccion) {
  if (incidentes.has(interseccion.indice)) return 'apagado';
  if (interseccion.modoNocturno && !interseccion.hayTrafico && !interseccion.emergencia) {
    return interseccion.fase === 'apagado' ? 'apagado' : 'amarillo';
  }
  return parDe(direccion) === interseccion.parActivo ? interseccion.fase : 'rojo';
}

function aplicarSemaforos(interseccion) {
  DIRECCIONES.forEach((direccion) => {
    const estado = estadoDelPar(interseccion, direccion);
    interseccion.semaforos[direccion] = estado;
    const caja = elemento(`sem${direccion[0].toUpperCase()}${direccion.slice(1)}-${interseccion.indice}`);
    if (!caja) return;
    const colores = {
      rojo: '#ff3333',
      amarillo: '#ffcc00',
      verde: '#00ff66',
      apagado: '#222222',
    };

    caja.querySelectorAll('.luz').forEach((luz) => {
      luz.classList.remove('activa');
      luz.style.backgroundColor = '#222222';
      luz.style.boxShadow = 'none';
    });

    // Los estados internos usan "rojo" y "amarillo", mientras que las
    // clases del HTML están en femenino: .roja y .amarilla.
    const claseLuz = { rojo: 'roja', amarillo: 'amarilla', verde: 'verde' }[estado];
    const luzActiva = claseLuz ? caja.querySelector(`.${claseLuz}`) : null;
      
    if (luzActiva && estado !== 'apagado') {
      luzActiva.classList.add('activa');
      luzActiva.style.backgroundColor = colores[estado];
      luzActiva.style.boxShadow = `0 0 8px ${colores[estado]}`;
    }
  });
}

function cambiarAPar(interseccion, par, duracion = 10) {
  if (incidentes.has(interseccion.indice)) return;
  interseccion.parActivo = par;
  interseccion.fase = 'verde';
  interseccion.restante = duracion;
  aplicarSemaforos(interseccion);
}

// Tiempo de verde adaptativo: crece según CUÁNTOS autos reales tienen fila
// en las direcciones del par recién activado (no solo si hay o no hay), y
// recibe un bono extra si el nodo fue notificado como ruta de desvío de un
// incidente cercano.
function calcularDuracionVerde(interseccion) {
  let duracion = interseccion.peaton ? 10 : 8;
  const direccionesDelPar = DIRECCIONES.filter((d) => parDe(d) === interseccion.parActivo);
  const colaPar = direccionesDelPar.reduce((total, d) => total + (interseccion.colaPorDireccion?.[d] || 0), 0);
  duracion += Math.min(colaPar * 2.5, 10);

  if (interseccion.alertaVecina && direccionesDelPar.includes(interseccion.alertaVecina.direccionEscape)) {
    duracion += 4;
  }
  return Math.min(duracion, 20);
}

function avanzarCiclo(interseccion) {
  // Nodo bloqueado por un choque: se mantiene en rojo total, sin ciclar,
  // hasta que se despeje el incidente.
  if (incidentes.has(interseccion.indice)) {
    aplicarSemaforos(interseccion);
    return;
  }

  if (interseccion.modoNocturno && !interseccion.hayTrafico && !interseccion.emergencia) {
    interseccion.fase = interseccion.fase === 'amarillo' ? 'apagado' : 'amarillo';
    aplicarSemaforos(interseccion);
    return;
  }

  // Al detectar un vehículo, el nodo abandona el parpadeo nocturno y vuelve
  // al ciclo completo verde → amarillo → rojo.
  if (interseccion.modoNocturno && interseccion.hayTrafico &&
      (interseccion.fase === 'apagado' || interseccion.fase === 'amarillo')) {
    reactivarNodoNocturno(interseccion);
  }

  // Corte anticipado ("semáforo actuado"): si el par que tiene el verde no
  // tiene NINGÚN auto esperando y el otro par sí, no tiene sentido agotar
  // los 8-20s completos con la calle vacía — se recorta a un mínimo seguro
  // (3s) para ceder el turno antes. Se deja un piso de 3s (el mismo que el
  // amarillo) para que ningún auto que ya venía entrando se quede sin
  // tiempo de cruzar.
  if (interseccion.fase === 'verde' && interseccion.restante > 3) {
    const direccionesActivas = DIRECCIONES.filter((d) => parDe(d) === interseccion.parActivo);
    const direccionesOpuestas = DIRECCIONES.filter((d) => parDe(d) !== interseccion.parActivo);
    const colaActiva = direccionesActivas.reduce((t, d) => t + (interseccion.colaPorDireccion?.[d] || 0), 0);
    const colaOpuesta = direccionesOpuestas.reduce((t, d) => t + (interseccion.colaPorDireccion?.[d] || 0), 0);
    if (colaActiva === 0 && colaOpuesta > 0) {
      interseccion.restante = 3;
    }
  }

  interseccion.restante -= 1;
  if (interseccion.restante > 0) return;
  if (interseccion.fase === 'verde') {
    interseccion.fase = 'amarillo';
    interseccion.restante = 3;
  } else {
    interseccion.parActivo = interseccion.parActivo === 'NS' ? 'EW' : 'NS';
    interseccion.fase = 'verde';
    interseccion.restante = calcularDuracionVerde(interseccion);
  }
  aplicarSemaforos(interseccion);
}

function reactivarNodoNocturno(interseccion) {
  const verticales = (interseccion.traficoPorDireccion?.norte || 0) + (interseccion.traficoPorDireccion?.sur || 0);
  const horizontales = (interseccion.traficoPorDireccion?.este || 0) + (interseccion.traficoPorDireccion?.oeste || 0);
  interseccion.parActivo = verticales > horizontales ? 'NS' : 'EW';
  interseccion.fase = 'verde';
  interseccion.restante = 8;
  aplicarSemaforos(interseccion);
}


/**
 * Registra un evento en el panel de eventos del sistema.
 * @param {string} mensaje - El texto a mostrar.
 * @param {string} tipo - 'ambulancia', 'hardware', 'alerta', o 'general'.
 */
function registrarEventoLog(mensaje, tipo = 'general') {
  const panel = document.getElementById('log-eventos-sistema');
  if (!panel) return;

  // Capturamos la hora local para el registro
  const ahora = new Date();
  const horaFormat = ahora.toLocaleTimeString('es-HN', { hour12: false });

  // Asignamos un ícono por defecto según el tipo
  let icono = '🔹';
  let claseColor = 'log-general';

  switch (tipo) {
    case 'ambulancia':
      icono = '🚑';
      claseColor = 'log-ambulancia';
      break;
    case 'ambulancia-rfid':
      icono = '🚑';
      claseColor = 'log-ambulancia-rfid'; // Azul
      break;  
    case 'hardware':
      icono = '📡';
      claseColor = 'log-hardware';
      break;
    case 'alerta':
      icono = '⚠️';
      claseColor = 'log-alerta';
      break;
  }

  // Creamos el nuevo elemento div
  const nuevoEvento = document.createElement('div');
  nuevoEvento.className = `evento-log ${claseColor}`;
  nuevoEvento.innerHTML = `[${horaFormat}] ${icono} ${mensaje}`;

  // Lo insertamos al principio del panel
  panel.prepend(nuevoEvento);
}

// Variable que hace referencia al elemento de texto del HTML
const lblEstadoAmbulancia = document.getElementById('estado-ambulancia');

/**
 * Función global para cambiar el texto de estado de la ambulancia
 */
function actualizarEstadoAmbulancia(mensaje, tiempoMs = 0) {
    if (!lblEstadoAmbulancia) {
        // Por si el elemento HTML aún no existe o tiene otro ID
        console.warn("No se encontró el elemento #estado-ambulancia en el DOM");
        return;
    }
    
    lblEstadoAmbulancia.textContent = mensaje;

    if (tiempoMs > 0) {
        setTimeout(() => {
            lblEstadoAmbulancia.textContent = "🚑 Ruta de emergencia prioritaria lista.";
        }, tiempoMs);
    }
}

//Actualizando Barra de Proximidad
function actualizarBarraProximidad(distancia) {
    const barra = document.getElementById('barra-proximidad'); 
    const textoDistancia = document.getElementById('texto-distancia'); 

    if (textoDistancia) {
        textoDistancia.textContent = `Auto a: ${distancia} cm`;
    }

    if (!barra) return;

    let porcentaje = 0;
    if (distancia <= 20) {
        porcentaje = 100;
    } else if (distancia >= 100) {
        porcentaje = 5; 
    } else {
        porcentaje = 100 - ((distancia - 20) / (100 - 20)) * 95;
    }

    let colorBarra = '#2ed573'; // Verde suave (>= 60cm)

    if (distancia <= 20) {
        colorBarra = '#ff4757'; // Rojo (Peligro)
    } else if (distancia > 20 && distancia <= 60) {
        colorBarra = '#ffa502'; // Naranja (Precaución)
    }

    barra.style.width = `${porcentaje}%`;
    barra.style.backgroundColor = colorBarra;
}

// Cada vehículo conserva el extremo opuesto como destino. Puede desviarse y
// doblar, pero nunca termina en una salida distinta a la que le corresponde.
function extremosDeVia(indice, direccion) {
  const fila = indice >= 4 ? 4 : 0;
  const columna = indice % 4;
  if (direccion === 'este') return { origen: fila, destino: fila + 3 };
  if (direccion === 'oeste') return { origen: fila + 3, destino: fila };
  if (direccion === 'sur') return { origen: columna, destino: columna + 4 };
  return { origen: columna + 4, destino: columna };
}

function direccionEntre(origen, destino) {
  const filaOrigen = Math.floor(origen / 4); const columnaOrigen = origen % 4;
  const filaDestino = Math.floor(destino / 4); const columnaDestino = destino % 4;
  if (filaDestino > filaOrigen) return 'sur';
  if (filaDestino < filaOrigen) return 'norte';
  return columnaDestino > columnaOrigen ? 'este' : 'oeste';
}

function crearVehiculo(indice, direccion, emergencia = false, tipo = 'auto', placa = '') {
  if (indice < 0 || indice >= NUM_NODOS || !DIRECCIONES.includes(direccion)) return;
  const { origen, destino } = extremosDeVia(indice, direccion);
  let destinoActivo = destino;
  let resultado = dijkstra(origen, destinoActivo);
  if (!resultado && !incidentes.has(origen)) {
    const alternativa = buscarSalidaAlternativa(origen, direccion, destinoActivo);
    if (alternativa) {
      destinoActivo = alternativa.destino;
      resultado = alternativa.resultado;
      registrarEventoIncidente(`Nuevo vehículo: salida alternativa INT-${destinoActivo + 1} por incidente en la ruta original.`, 'info');
    }
  }
  if (!resultado) {
    registrarEventoIncidente(`No hay ruta segura hacia INT-${destino + 1}; vehículo no creado.`, 'alerta');
    return;
  }
  // Dijkstra incorpora las colas e incidentes actuales antes de permitir que
  // el vehículo entre a la cuadrícula.
  const ruta = resultado.ruta;
  const vehiculo = {
    id: siguienteVehiculo++,
    indice,
    direccion,
    emergencia,
    tipo,
    placa,
    origen,
    destino: destinoActivo,
    destinoOriginal: destino,
    // El recorrido abarca toda la avenida o calle vertical; así el auto nace
    // fuera del mapa y entra por el extremo real de la vía.
    progreso: 0,
    ruta,
    siguienteControl: 0,
    espera: 0,
    detenido: false,
    nodoEspera: null,
  };
  vehiculos.push(vehiculo);
  if (emergencia) {
    intersecciones[indice].emergencia = direccion;
    cambiarAPar(intersecciones[indice], parDe(direccion), 12);
    estadisticas.emergencias += 1;
  }
}

function segmentosDeRuta(vehiculo, escenario) {
  const rectEscenario = escenario.getBoundingClientRect();
  const centros = vehiculo.ruta.map((nodo) => {
    const rect = nodoElemento(nodo)?.getBoundingClientRect();
    return rect && {
      left: rect.left - rectEscenario.left + rect.width / 2,
      top: rect.top - rectEscenario.top + rect.height / 2,
    };
  });
  if (centros.some((centro) => !centro)) return null;
  const desplazamientoCarril = {
    este: { left: 0, top: 20 }, oeste: { left: 0, top: -20 },
    sur: { left: -20, top: 0 }, norte: { left: 20, top: 0 },
  };
  const puntoEnCarril = (centro, direccion) => ({
    left: centro.left + desplazamientoCarril[direccion].left,
    top: centro.top + desplazamientoCarril[direccion].top,
  });
  const primero = centros[0]; const ultimo = centros[centros.length - 1];
  const entrada = {
    este: { left: -28, top: puntoEnCarril(primero, 'este').top },
    oeste: { left: rectEscenario.width + 28, top: puntoEnCarril(primero, 'oeste').top },
    sur: { left: puntoEnCarril(primero, 'sur').left, top: -28 },
    norte: { left: puntoEnCarril(primero, 'norte').left, top: rectEscenario.height + 28 },
  }[vehiculo.direccion];
  const salida = {
    este: { left: rectEscenario.width + 28, top: puntoEnCarril(ultimo, 'este').top },
    oeste: { left: -28, top: puntoEnCarril(ultimo, 'oeste').top },
    sur: { left: puntoEnCarril(ultimo, 'sur').left, top: rectEscenario.height + 28 },
    norte: { left: puntoEnCarril(ultimo, 'norte').left, top: -28 },
  }[vehiculo.direccion];
  const puntos = [entrada];
  const segmentosControl = [];
  vehiculo.ruta.forEach((nodo, indice) => {
    const direccionLlegada = indice ? direccionEntre(vehiculo.ruta[indice - 1], nodo) : vehiculo.direccion;
    puntos.push(puntoEnCarril(centros[indice], direccionLlegada));
    segmentosControl[indice] = puntos.length - 2;
    const direccionSalida = indice < vehiculo.ruta.length - 1
      ? direccionEntre(nodo, vehiculo.ruta[indice + 1])
      : vehiculo.direccion;
    if (direccionSalida !== direccionLlegada) puntos.push(puntoEnCarril(centros[indice], direccionSalida));
  });
  puntos.push(salida);
  const segmentos = puntos.slice(1).map((fin, i) => ({
    inicio: puntos[i], fin,
    longitud: Math.hypot(fin.left - puntos[i].left, fin.top - puntos[i].top),
  }));
  return {
    puntos, segmentos, segmentosControl,
    longitudTotal: segmentos.reduce((suma, segmento) => suma + segmento.longitud, 0),
  };
}

function posicionVehiculo(vehiculo, escenario) {
  const trayecto = segmentosDeRuta(vehiculo, escenario);
  if (!trayecto || !trayecto.longitudTotal) return null;
  let distancia = Math.max(0, Math.min(100, vehiculo.progreso)) / 100 * trayecto.longitudTotal;
  for (const segmento of trayecto.segmentos) {
    if (distancia <= segmento.longitud) {
      const proporcion = segmento.longitud ? distancia / segmento.longitud : 1;
      return {
        left: segmento.inicio.left + (segmento.fin.left - segmento.inicio.left) * proporcion,
        top: segmento.inicio.top + (segmento.fin.top - segmento.inicio.top) * proporcion,
      };
    }
    distancia -= segmento.longitud;
  }
  return trayecto.puntos[trayecto.puntos.length - 1];
}

function crearSensoresVisuales() {
  intersecciones.forEach((interseccion) => {
    const nodo = nodoElemento(interseccion.indice);
    if (!nodo || elemento(`sensorCentral-${interseccion.indice}`)) return;

    const radio = document.createElement('div');
    radio.id = `radioSensor-${interseccion.indice}`;
    Object.assign(radio.style, {
      position: 'absolute', width: `${RADIO_SENSOR_CENTRAL_PX * 2}px`, height: `${RADIO_SENSOR_CENTRAL_PX * 2}px`,
      border: '2px dashed rgba(46, 204, 113, .7)', borderRadius: '50%', left: '50%', top: '50%',
      transform: 'translate(-50%, -50%)', opacity: '.16', pointerEvents: 'none', zIndex: '4', transition: 'opacity .2s',
    });
    const central = document.createElement('span');
    central.id = `sensorCentral-${interseccion.indice}`;
    central.title = `CAM-INT${interseccion.indice + 1}`;
    Object.assign(central.style, {
      position: 'absolute', width: '10px', height: '10px', borderRadius: '50%', background: '#46504a',
      left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: '5', transition: 'all .2s',
    });
    nodo.append(radio, central);

    const ubicaciones = {
      // Cada nombre indica el lado por donde llega el vehículo.
      // Quedan inmediatamente antes de la cebra, sin invadirla.
      norte: { left: '3px', top: '-32px', width: '30px', height: '15px' },
      sur: { left: '46px', bottom: '-32px', width: '30px', height: '15px' },
      este: { right: '-32px', top: '5px', width: '15px', height: '30px' },
      oeste: { left: '-32px', top: '46px', width: '15px', height: '30px' },
    };
    DIRECCIONES.forEach((direccion) => {
      const sensor = document.createElement('div');
      sensor.id = `sensor-${direccion}-${interseccion.indice}`;
      sensor.title = `SEN-${direccion[0].toUpperCase()}-INT${interseccion.indice + 1}`;
      Object.assign(sensor.style, {
        position: 'absolute', border: '2px solid #f39c12', borderRadius: '3px', zIndex: '5',
        boxShadow: '0 0 4px rgba(243, 156, 18, .5)', transition: 'all .2s', ...ubicaciones[direccion],
      });
      nodo.appendChild(sensor);
    });
  });
}

function actualizarSensores() {
  const escenario = document.querySelector('.escenario-trafico');
  if (!escenario) return;
  const rectEscenario = escenario.getBoundingClientRect();

  intersecciones.forEach((interseccion) => {
    const nodo = nodoElemento(interseccion.indice);
    const rectNodo = nodo?.getBoundingClientRect();
    if (!rectNodo) return;
    const centroX = rectNodo.left - rectEscenario.left + rectNodo.width / 2;
    const centroY = rectNodo.top - rectEscenario.top + rectNodo.height / 2;
    const detectados = { norte: false, sur: false, este: false, oeste: false };
    let actividadCentral = false;
    const sensorDeEntrada = { sur: 'norte', norte: 'sur', oeste: 'este', este: 'oeste' };

    vehiculos.forEach((vehiculo) => {
      const posicion = posicionVehiculo(vehiculo, escenario);
      if (!posicion) return;
      const distancia = Math.hypot(posicion.left - centroX, posicion.top - centroY);
      if (distancia <= RADIO_SENSOR_CENTRAL_PX && vehiculo.ruta.includes(interseccion.indice)) {
        actividadCentral = true;
      }

      // OJO: no usar vehiculo.direccion directo — esa es la dirección con la
      // que ENTRÓ a la cuadrícula y no cambia cuando el auto dobla. Hay que
      // calcular con qué dirección llega específicamente a ESTA
      // intersección, revisando el nodo anterior en su ruta.
      const idxNodo = vehiculo.ruta.indexOf(interseccion.indice);
      if (idxNodo === -1) return;
      const direccionLlegada = idxNodo === 0
        ? vehiculo.direccion
        : direccionEntre(vehiculo.ruta[idxNodo - 1], vehiculo.ruta[idxNodo]);

      const nombreSensor = sensorDeEntrada[direccionLlegada];
      const sensor = elemento(`sensor-${nombreSensor}-${interseccion.indice}`);
      const rectSensor = sensor?.getBoundingClientRect();
      if (rectSensor) {
        const xSensor = rectSensor.left - rectEscenario.left;
        const ySensor = rectSensor.top - rectEscenario.top;
        const margen = 18;
        const sobreSensor = posicion.left >= xSensor - margen &&
          posicion.left <= xSensor + rectSensor.width + margen &&
          posicion.top >= ySensor - margen &&
          posicion.top <= ySensor + rectSensor.height + margen;
        if (sobreSensor) detectados[nombreSensor] = true;
      }
    });

    interseccion.traficoPorDireccion = Object.fromEntries(DIRECCIONES.map((dir) => [dir, detectados[dir] ? 1 : 0]));
    interseccion.sensorCentralActivo = actividadCentral;
    interseccion.hayTrafico = actividadCentral || Object.values(detectados).some(Boolean);
    if (interseccion.modoNocturno && interseccion.hayTrafico &&
        (interseccion.fase === 'apagado' || interseccion.fase === 'amarillo')) {
      reactivarNodoNocturno(interseccion);
    }

    const activo = interseccion.hayTrafico;
    const central = elemento(`sensorCentral-${interseccion.indice}`);
    const radio = elemento(`radioSensor-${interseccion.indice}`);
    if (central) Object.assign(central.style, activo
      ? { background: '#2ecc71', boxShadow: '0 0 10px #2ecc71' }
      : { background: '#46504a', boxShadow: 'none' });
    if (radio) radio.style.opacity = activo ? '.75' : '.16';
    DIRECCIONES.forEach((direccion) => {
      const sensor = elemento(`sensor-${direccion}-${interseccion.indice}`);
      if (sensor) Object.assign(sensor.style, detectados[direccion]
        ? { borderColor: '#2ecc71', boxShadow: '0 0 8px #2ecc71' }
        : { borderColor: '#f39c12', boxShadow: '0 0 4px rgba(243, 156, 18, .5)' });
    });
  });
}

function salidasDelMismoBorde(direccion) {
  if (direccion === 'oeste') return [0, 4];
  if (direccion === 'este') return [3, 7];
  if (direccion === 'norte') return [0, 1, 2, 3];
  return [4, 5, 6, 7];
}

function buscarSalidaAlternativa(origen, direccion, destinoActual) {
  return salidasDelMismoBorde(direccion)
    .filter((destino) => destino !== destinoActual && !incidentes.has(destino))
    .map((destino) => ({ destino, resultado: dijkstra(origen, destino) }))
    .filter((opcion) => opcion.resultado)
    .sort((a, b) => a.resultado.costo - b.resultado.costo)[0] || null;
}

function recalcularDesvio(vehiculo, escenario) {
  const indiceIncidente = vehiculo.ruta.findIndex((nodo, indice) =>
    indice >= vehiculo.siguienteControl && incidentes.has(nodo));
  let indiceDecision = vehiculo.siguienteControl;
  if (indiceIncidente >= 0) indiceDecision = Math.max(vehiculo.siguienteControl, indiceIncidente - 1);
  if (indiceIncidente < 0 && vehiculo.nodoEspera !== null) {
    indiceDecision = Math.max(vehiculo.siguienteControl, vehiculo.ruta.indexOf(vehiculo.nodoEspera));
  }
  const restante = vehiculo.ruta.slice(indiceDecision);
  const hayIncidenteEnRuta = restante.some((nodo) => incidentes.has(nodo));
  if (!hayIncidenteEnRuta && vehiculo.nodoEspera === null) return;

  // El siguiente nodo es la intersección en la que todavía puede doblar. Se
  // recalcula antes de entrar en ella, por lo que el desvío ocurre un nodo
  // antes del incidente y el auto conserva su destino original.
  const nodoDecision = vehiculo.ruta[indiceDecision];
  let resultado = dijkstra(nodoDecision, vehiculo.destino);
  if (!resultado) {
    const alternativa = buscarSalidaAlternativa(nodoDecision, vehiculo.direccion, vehiculo.destino);
    if (alternativa) {
      vehiculo.destino = alternativa.destino;
      resultado = alternativa.resultado;
      registrarEventoIncidente(`Vehículo #${vehiculo.id}: salida alternativa INT-${vehiculo.destino + 1} por bloqueo de la salida original.`, 'info');
    }
  }
  if (!resultado) {
    if (vehiculo.nodoEspera === nodoDecision) return;
    vehiculo.nodoEspera = nodoDecision;
    registrarEventoIncidente(`INT-${nodoDecision + 1}: sin desvío seguro para vehículo #${vehiculo.id}.`, 'alerta');
    return;
  }

  const nuevaRuta = [...vehiculo.ruta.slice(0, indiceDecision), ...resultado.ruta];
  vehiculo.nodoEspera = null;
  if (nuevaRuta.join('-') === vehiculo.ruta.join('-')) return;

  // OJO: "progreso" es un porcentaje de la longitud TOTAL de la ruta. Si se
  // cambia vehiculo.ruta sin más, ese mismo porcentaje pasa a representar
  // una posición física distinta (normalmente más adelantada, porque el
  // desvío suele ser más largo que el camino recto original) — el auto
  // "salta" hacia adelante, incluso saltándose el paso peatonal. Por eso
  // hay que congelar su posición física ANTES del cambio de ruta y volver
  // a expresarla como porcentaje de la ruta NUEVA después del cambio.
  const trayectoViejo = segmentosDeRuta(vehiculo, escenario);
  const distanciaFisicaActual = trayectoViejo?.longitudTotal
    ? (vehiculo.progreso / 100) * trayectoViejo.longitudTotal
    : null;

  vehiculo.ruta = nuevaRuta;

  if (distanciaFisicaActual !== null) {
    const trayectoNuevo = segmentosDeRuta(vehiculo, escenario);
    if (trayectoNuevo?.longitudTotal) {
      vehiculo.progreso = Math.min(100, (distanciaFisicaActual / trayectoNuevo.longitudTotal) * 100);
    }
  }

  const anterior = indiceDecision ? nuevaRuta[indiceDecision - 1] : null;
  const direccionLlegada = anterior === null ? vehiculo.direccion : direccionEntre(anterior, nodoDecision);
  const interseccion = intersecciones[nodoDecision];
  if (!incidentes.has(nodoDecision)) cambiarAPar(interseccion, parDe(direccionLlegada), 12);
  registrarEventoIncidente(`Desvío aplicado al vehículo #${vehiculo.id}: INT-${nodoDecision + 1} → INT-${vehiculo.destino + 1}.`, 'info');
}

// Identifica el tramo de calle FÍSICO que el vehículo está recorriendo en
// este instante (independientemente de cuál sea el resto de su ruta), y
// cuánto ha avanzado dentro de ese tramo en píxeles. Esto es necesario
// porque "progreso" es un porcentaje de la ruta COMPLETA de cada auto, y
// dos autos con rutas distintas (uno sigue derecho, otro va a doblar más
// adelante) no son comparables usando ese porcentaje aunque en este
// momento vayan exactamente por la misma calle, en el mismo carril.
function segmentoFisicoActual(vehiculo, trayecto) {
  if (!trayecto || !trayecto.longitudTotal) return null;
  const idxControl = trayecto.segmentosControl[vehiculo.siguienteControl];
  const idxSegmento = idxControl !== undefined ? idxControl : trayecto.segmentos.length - 1;
  const segmento = trayecto.segmentos[idxSegmento];
  if (!segmento) return null;

  const distanciaHastaInicio = trayecto.segmentos
    .slice(0, idxSegmento)
    .reduce((total, s) => total + s.longitud, 0);
  const distanciaRecorrida = (vehiculo.progreso / 100) * trayecto.longitudTotal;

  const nodoObjetivo = vehiculo.ruta[vehiculo.siguienteControl];
  const ultimoNodo = vehiculo.ruta[vehiculo.ruta.length - 1];
  const anterior = vehiculo.siguienteControl ? vehiculo.ruta[vehiculo.siguienteControl - 1] : null;
  const direccionActual = nodoObjetivo !== undefined
    ? (anterior === null ? vehiculo.direccion : direccionEntre(anterior, nodoObjetivo))
    : (vehiculo.ruta.length > 1 ? direccionEntre(vehiculo.ruta[vehiculo.ruta.length - 2], ultimoNodo) : vehiculo.direccion);

  return {
    // Dos vehículos en el mismo tramo físico (misma calle, mismo sentido,
    // mismo nodo de destino) comparten este identificador aunque el resto
    // de su ruta sea diferente.
    id: `${direccionActual}-${nodoObjetivo !== undefined ? nodoObjetivo : `salida${ultimoNodo}`}`,
    avancePx: distanciaRecorrida - distanciaHastaInicio,
    longitudPx: segmento.longitud,
  };
}

function debeDetenerseEnSemaforo(vehiculo, escenario, avancePorcentaje) {
  const nodoActual = vehiculo.ruta[vehiculo.siguienteControl];
  if (nodoActual === undefined) return false;
  const trayecto = segmentosDeRuta(vehiculo, escenario);
  if (!trayecto || !trayecto.longitudTotal) return false;
  const indiceSegmentoControl = trayecto.segmentosControl[vehiculo.siguienteControl];
  const segmento = trayecto.segmentos[indiceSegmentoControl];
  const distanciaHastaNodo = trayecto.segmentos
    .slice(0, indiceSegmentoControl + 1)
    .reduce((total, tramo) => total + tramo.longitud, 0);
  const margen = Math.min(DISTANCIA_ANTES_CEBRA_PX, Math.max(segmento.longitud - 10, segmento.longitud * 0.5));
  const limite = ((distanciaHastaNodo - margen) / trayecto.longitudTotal) * 100;
  if (vehiculo.progreso + avancePorcentaje < limite) return false;

  // Sin ruta alternativa, el vehículo espera detrás de la cebra aun cuando
  // el semáforo cambie a verde. Al despejarse el incidente vuelve a calcular.
  if (vehiculo.nodoEspera === nodoActual) return true;

  if (vehiculo.emergencia) {
    vehiculo.siguienteControl += 1;
    return false;
  }
  const anterior = vehiculo.siguienteControl ? vehiculo.ruta[vehiculo.siguienteControl - 1] : null;
  const direccionLlegada = anterior === null ? vehiculo.direccion : direccionEntre(anterior, nodoActual);
  if (estadoDelPar(intersecciones[nodoActual], direccionLlegada) !== 'verde') return true;
  vehiculo.siguienteControl += 1;
  return false;
}

function actualizarVehiculos() {
  const escenario = document.querySelector('.escenario-trafico');
  if (!escenario) return;

  const contexto = new Map();
  vehiculos.forEach((vehiculo) => {
    recalcularDesvio(vehiculo, escenario);

    if (vehiculo.emergencia) {
    const nodoActual = vehiculo.ruta[vehiculo.siguienteControl];
    const nodoDestino = vehiculo.destino;

    // 1. Variable creada correctamente
    const nombreAmbulancia = vehiculo.esRfid ? "Ambulancia (SENSOR RFID)" : "Ambulancia";

    if (nodoActual !== undefined) {
         // CORRECCIÓN: Usamos la variable ${nombreAmbulancia}
         actualizarEstadoAmbulancia(
            `🚑 ${nombreAmbulancia} en camino: Intersección ${nodoActual + 1} ➔ Intersección ${nodoDestino + 1}`, 0
         );

         if (vehiculo.ultimoNodoReportado !== nodoActual) {
            const tipoRegistro = vehiculo.esRfid ? "ambulancia-rfid" : "ambulancia";
            
            // CORRECCIÓN: Usamos ${nombreAmbulancia} y quitamos las comillas de tipoRegistro
            registrarEventoLog(`${nombreAmbulancia} cruzando Intersección ${nodoActual + 1}`, tipoRegistro);
             
            vehiculo.ultimoNodoReportado = nodoActual; 
         }
      }
    }

    const avance = vehiculo.emergencia ? VELOCIDAD_EMERGENCIA : VELOCIDAD_AUTO;
    vehiculo.detenido = debeDetenerseEnSemaforo(vehiculo, escenario, avance);
    const trayecto = segmentosDeRuta(vehiculo, escenario);
    contexto.set(vehiculo, {
      avancePendiente: vehiculo.detenido ? 0 : avance,
      trayecto,
      segmentoFisico: segmentoFisicoActual(vehiculo, trayecto),
    });
  });

  // Antes se agrupaba por la ruta COMPLETA de cada auto ("direccion-ruta"),
  // así que dos vehículos que en este momento van por la misma calle y el
  // mismo carril, pero que más adelante tomarán caminos distintos (uno
  // sigue derecho, otro va a doblar), nunca se comparaban entre sí — el de
  // atrás no "veía" al de adelante y lo traspasaba. Ahora se agrupan por
  // el tramo físico real (segmentoFisico.id), que identifica la calle y el
  // sentido de circulación en el que están AHORA MISMO, sin importar el
  // resto de la ruta de cada uno.
  const carriles = new Map();
  contexto.forEach((info, vehiculo) => {
    if (!info.segmentoFisico) return;
    const llave = info.segmentoFisico.id;
    if (!carriles.has(llave)) carriles.set(llave, []);
    carriles.get(llave).push(vehiculo);
  });

  carriles.forEach((autosCarril) => {
    // El más avanzado dentro del tramo físico compartido va al frente,
    // sin importar qué porcentaje de SU ruta total represente eso.
    autosCarril.sort((a, b) => contexto.get(b).segmentoFisico.avancePx - contexto.get(a).segmentoFisico.avancePx);
    autosCarril.forEach((vehiculo, posicion) => {
      const info = contexto.get(vehiculo);
      const autoDelante = autosCarril[posicion - 1];
      const trayecto = info.trayecto;
      let avancePorcentaje = info.avancePendiente;
      if (autoDelante && trayecto?.longitudTotal) {
        const infoDelante = contexto.get(autoDelante);
        const espacioDisponiblePx = infoDelante.segmentoFisico.avancePx - DISTANCIA_MINIMA_AUTOS_PX - info.segmentoFisico.avancePx;
        const avancePendientePx = (avancePorcentaje / 100) * trayecto.longitudTotal;
        const avancePx = Math.min(avancePendientePx, Math.max(0, espacioDisponiblePx));
        avancePorcentaje = (avancePx / trayecto.longitudTotal) * 100;
        if (avancePx <= 0) vehiculo.detenido = true;
      }
      if (vehiculo.detenido) vehiculo.espera += INTERVALO_MOVIMIENTO_MS / 1000;
      vehiculo.progreso += avancePorcentaje;
    });
  });

  const salidos = vehiculos.filter((vehiculo) => vehiculo.progreso > 103);
  salidos.forEach((vehiculo) => {
  estadisticas.procesados += 1;
  estadisticas.esperaAcumulada += vehiculo.espera;
  estadisticas.autosConEspera += 1;
  
  // Verificamos únicamente si el vehículo que salió es la ambulancia
  if (vehiculo.emergencia) {
    if (intersecciones[vehiculo.indice] && intersecciones[vehiculo.indice].emergencia === vehiculo.direccion) {
      intersecciones[vehiculo.indice].emergencia = null;
    }

    const nombreAmbulancia = vehiculo.esRfid ? "Ambulancia (SENSOR RFID)" : "Ambulancia";
    const tipoRegistro = vehiculo.esRfid ? "ambulancia-rfid" : "ambulancia";

    // CORRECCIÓN: Usamos la variable ${nombreAmbulancia} en lugar de la palabra fija
    actualizarEstadoAmbulancia(`🚑 ${nombreAmbulancia} llegó a su destino final.`, 0);
    registrarEventoLog(`${nombreAmbulancia} ha llegado a su destino exitosamente.`, tipoRegistro);

    setTimeout(() => {
      actualizarEstadoAmbulancia(`🚑 Ruta de emergencia prioritaria lista`, 0);
    }, 4000);
  }
});

vehiculos = vehiculos.filter((vehiculo) => vehiculo.progreso <= 103);
}

function actualizarEmergenciasEnRuta() {
  intersecciones.forEach(interseccion => { interseccion.emergencia = null; });

  vehiculos.filter(v => v.emergencia).forEach(vehiculo => {
    const nodoActual = vehiculo.ruta[vehiculo.siguienteControl];
    if (nodoActual !== undefined) {
      const interseccion = intersecciones[nodoActual];
      const anterior = vehiculo.siguienteControl ? vehiculo.ruta[vehiculo.siguienteControl - 1] : null;
      const direccionLlegada = anterior === null ? vehiculo.direccion : direccionEntre(anterior, nodoActual);
      interseccion.emergencia = direccionLlegada;
      if (parDe(direccionLlegada) !== interseccion.parActivo) {
        cambiarAPar(interseccion, parDe(direccionLlegada), 10);
      }
    }
  });
}



function pintarVehiculos() {
  const escenario = document.querySelector('.escenario-trafico');
  if (!escenario) return;
  let capa = elemento('capaVehiculos');
  if (!capa) {
    capa = document.createElement('div');
    capa.id = 'capaVehiculos';
    Object.assign(capa.style, {
      // Por encima de la etiqueta del nodo, pero por debajo de los semáforos (z-index: 100).
      position: 'absolute', inset: '0', zIndex: '50', pointerEvents: 'none', overflow: 'hidden',
    });
    escenario.appendChild(capa);
  }
  capa.replaceChildren();
  vehiculos.forEach((vehiculo) => {
    const posicion = posicionVehiculo(vehiculo, escenario);
    if (!posicion) return;
    const el = document.createElement('span');
    el.className = 'vehiculo-simulado';
    el.textContent = vehiculo.emergencia ? '🚑' : vehiculo.tipo === 'camion' ? '🚚' : ['🚗', '🚙', '🚕'][vehiculo.id % 3];
    Object.assign(el.style, {
      position: 'absolute', zIndex: '8', fontSize: '17px', lineHeight: '1',
      pointerEvents: 'none', transition: 'left .06s linear, top .06s linear',
      filter: vehiculo.detenido ? 'grayscale(.65)' : 'none',
      left: `${posicion.left}px`, top: `${posicion.top}px`,
      transform: `translate(-50%, -50%)${vehiculo.direccion === 'este' ? ' scaleX(-1)' : ''}`,
    });
    capa.appendChild(el);
  });
}

function solicitarPeaton(indice, ladoSolicitado = null) {
  const interseccion = intersecciones[indice];
  if (!interseccion || interseccion.peaton) return;
  const lado = DIRECCIONES.includes(ladoSolicitado)
    ? ladoSolicitado
    : ['oeste', 'este', 'norte', 'sur'][Math.floor(Math.random() * 4)];
  interseccion.peaton = { lado, iniciado: false };
  const contenedor = nodoElemento(indice);
  const el = document.createElement('span');
  el.id = `peaton-${indice}`;
  el.textContent = '🚶';
  // Cada recorrido comienza en una esquina y cruza la cebra adyacente.
  const puntoInicio = {
    norte: { left: '96%', top: '-20px' },
    sur: { left: '-30px', top: '96%' },
    oeste: { left: '-23px', top: '106%' },
    este: { left: '96%', top: '-30px' },
  }[lado];
  Object.assign(el.style, {
    position: 'absolute', zIndex: '9', fontSize: '18px', pointerEvents: 'none',
    ...puntoInicio,
    transition: 'all 1.8s linear',
  });
  contenedor?.appendChild(el);
}

// Se expone para los botones onclick que ya están en el HTML.
window.activarPeatonal = solicitarPeaton;

function actualizarPeatones() {
  intersecciones.forEach((interseccion) => {
    if (!interseccion.peaton) return;
    const { lado, iniciado } = interseccion.peaton;
    const seguro = parDe(lado) !== interseccion.parActivo && interseccion.fase === 'verde';
    if (!seguro || iniciado) return;
    interseccion.peaton.iniciado = true;
    const el = elemento(`peaton-${interseccion.indice}`);
    if (el) {
      if (lado === 'norte' || lado === 'sur') el.style.left = lado === 'norte' ? '-20px' : '76%';
      if (lado === 'oeste' || lado === 'este') el.style.top = lado === 'oeste' ? '-20px' : '76%';
    }
    setTimeout(() => {
      elemento(`peaton-${interseccion.indice}`)?.remove();
      interseccion.peaton = null;
    }, 2000);
  });
}

function crearPaneles() {
  const matriz = elemento('matrizEstadoSemaforos');
  if (matriz) {
    matriz.innerHTML = '';
    intersecciones.forEach((interseccion) => {
      const fila = document.createElement('div');
      fila.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #2d3b2f';
      fila.innerHTML = `<span>Intersección ${interseccion.indice +1}</span><span id="luces-${interseccion.indice}" style="display:flex;gap:10px"></span>`;
      matriz.appendChild(fila);
    });
  }

  const diagnostico = elemento('diagnosticoGrid');
  if (diagnostico) diagnostico.innerHTML = intersecciones.map((_, i) =>
    `<div class="diagnostico-item" id="diagnostico-${i}">[INT-${i + 1}] Esperando actividad…</div>`).join('');

  const estadoSensores = elemento('estadoSensoresGrid');
  if (estadoSensores) {
    const filas = (i) => [
      ['norte', `SEN-N-INT${i + 1}`], ['sur', `SEN-S-INT${i + 1}`],
      ['este', `SEN-E-INT${i + 1}`], ['oeste', `SEN-O-INT${i + 1}`],
      ['camara', `CAM-INT${i + 1}`],
    ].map(([tipo, nombre]) =>
      `<div class="fila-sensor-estado"><span class="indicador-sensor-estado" id="estadoSensor-${i}-${tipo}"></span>${nombre}</div>`).join('');
    estadoSensores.innerHTML = intersecciones.map((_, i) =>
      `<article class="tarjeta-sensor-estado"><h4>INTERSECCIÓN ${i + 1}</h4>${filas(i)}</article>`).join('') +
      `<article class="tarjeta-sensor-estado"><h4>EMERGENCIA</h4><div class="fila-sensor-estado"><span class="indicador-sensor-estado" id="estadoSensor-rfid"></span>RFID-AMBULANCIA</div></article>`;
  }
}

function actualizarPanelActividadSensores() {
  intersecciones.forEach((interseccion) => {
    DIRECCIONES.forEach((direccion) => {
      elemento(`estadoSensor-${interseccion.indice}-${direccion}`)?.classList.toggle(
        'activo', Boolean(interseccion.traficoPorDireccion?.[direccion]),
      );
    });
    elemento(`estadoSensor-${interseccion.indice}-camara`)?.classList.toggle(
      'activo', Boolean(interseccion.sensorCentralActivo),
    );
  });
  elemento('estadoSensor-rfid')?.classList.toggle('activo', vehiculos.some((vehiculo) => vehiculo.emergencia));
}

function actualizarPaneles() {
  intersecciones.forEach((interseccion) => {
    const luces = elemento(`luces-${interseccion.indice}`);
    if (luces) luces.innerHTML = DIRECCIONES.map((dir) => {
      const estado = interseccion.semaforos[dir];
      const clase = estado === 'apagado' ? '' : estado === 'rojo' ? 'roja' : estado === 'amarillo' ? 'amarilla' : 'verde';
      return `<span class="led-matriz ${clase}" title="${dir}: ${estado}"></span>`;
    }).join('');
    const diagnostico = elemento(`diagnostico-${interseccion.indice}`);
    if (diagnostico) {
      const activos = DIRECCIONES.filter((dir) => interseccion.traficoPorDireccion?.[dir]).map((dir) => dir[0].toUpperCase()).join(', ') || 'ninguno';
      diagnostico.textContent = `[INT-${interseccion.indice + 1}] CAM: ${interseccion.hayTrafico ? 'activo' : 'libre'} · SEN: ${activos}`;
    }
  });

  const sensoresActivos = intersecciones.reduce((total, interseccion) =>
    total + DIRECCIONES.filter((direccion) => interseccion.traficoPorDireccion?.[direccion]).length +
    (interseccion.sensorCentralActivo ? 1 : 0), 0);
  const resumenSensores = elemento('resumenSensores');
  if (resumenSensores) resumenSensores.textContent = `Sensores activos: ${sensoresActivos} / 40`;

  elemento('statVehiculos').textContent = estadisticas.procesados;
  elemento('statEsperandoAhora').textContent = vehiculos.filter((v) => v.detenido).length;
  elemento('statEmergencias').textContent = estadisticas.emergencias;
  const promedio = estadisticas.autosConEspera ? (estadisticas.esperaAcumulada / estadisticas.autosConEspera).toFixed(1) : '0';
  elemento('statTiempoEspera').textContent = `${promedio}s`;
  elemento('txtEstadoSemaforos').textContent = olaVerdeActiva ? 'Ola verde activa' : 'Sistemas operativos (sincronizado)';
  actualizarPanelActividadSensores();
}

function dibujarGrafica() {
  const canvas = elemento('graficaTrafico');
  if (!canvas) return;
  const ancho = canvas.clientWidth || 260;
  const alto = canvas.clientHeight || 120;
  const densidad = window.devicePixelRatio || 1;
  canvas.width = Math.round(ancho * densidad);
  canvas.height = Math.round(alto * densidad);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(densidad, 0, 0, densidad, 0, 0);
  ctx.clearRect(0, 0, ancho, alto);

  const margen = { izquierdo: 22, derecho: 3, superior: 7, inferior: 17 };
  const anchoGrafica = ancho - margen.izquierdo - margen.derecho;
  const altoGrafica = alto - margen.superior - margen.inferior;
  const maximo = Math.max(5, ...historialTrafico);

  ctx.font = '9px Rubik, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let paso = 0; paso <= 3; paso += 1) {
    const valor = Math.round((maximo * (3 - paso)) / 3);
    const y = margen.superior + (altoGrafica * paso) / 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, .08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margen.izquierdo, y);
    ctx.lineTo(ancho - margen.derecho, y);
    ctx.stroke();
    ctx.fillStyle = '#8b8b8b';
    ctx.fillText(String(valor), margen.izquierdo - 5, y);
  }

  if (historialTrafico.length < 2) return;
  const punto = (valor, indice) => ({
    x: margen.izquierdo + (indice / (historialTrafico.length - 1)) * anchoGrafica,
    y: margen.superior + altoGrafica - (valor / maximo) * altoGrafica,
  });

  const degradado = ctx.createLinearGradient(0, margen.superior, 0, margen.superior + altoGrafica);
  degradado.addColorStop(0, 'rgba(46, 204, 113, .32)');
  degradado.addColorStop(1, 'rgba(46, 204, 113, .06)');
  ctx.beginPath();
  historialTrafico.forEach((valor, i) => {
    const { x, y } = punto(valor, i);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  const ultimoPunto = punto(historialTrafico[historialTrafico.length - 1], historialTrafico.length - 1);
  ctx.lineTo(ultimoPunto.x, margen.superior + altoGrafica);
  ctx.lineTo(margen.izquierdo, margen.superior + altoGrafica);
  ctx.closePath();
  ctx.fillStyle = degradado;
  ctx.fill();

  ctx.strokeStyle = '#2ecc71';
  ctx.lineWidth = 2;
  ctx.beginPath();
  historialTrafico.forEach((valor, i) => {
    const { x, y } = punto(valor, i);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

function registrarMuestra() {
  historialTrafico.push(vehiculos.filter((v) => v.detenido).length);
  if (historialTrafico.length > 30) historialTrafico.shift();
  dibujarGrafica();
}

function actualizarRutaManual() {
  const direccion = elemento('selectEntradaVehiculo')?.value || 'este';
  const carril = elemento('selectCarrilVehiculo');
  const salida = elemento('selectSalidaVehiculo');
  if (!carril || !salida) return;

  const opciones = (direccion === 'este' || direccion === 'oeste')
    ? [['0', 'Carril 1 · Boulevard norte'], ['4', 'Carril 2 · Boulevard sur']]
    : [['0', 'Carril 1'], ['1', 'Carril 2'], ['2', 'Carril 3'], ['3', 'Carril 4']];
  const textosSalida = {
    este: 'SAL-E · Boulevard Este', oeste: 'SAL-O · Boulevard Oeste',
    sur: 'SAL-S · Avenida Sur', norte: 'SAL-N · Avenida Norte',
  };
  carril.innerHTML = opciones.map(([valor, texto]) => `<option value="${valor}">${texto}</option>`).join('');
  salida.innerHTML = `<option>${textosSalida[direccion]}</option>`;
}

function inyectarVehiculos() {
  const direccion = elemento('selectEntradaVehiculo')?.value || 'este';
  const indice = Number(elemento('selectCarrilVehiculo')?.value || 0);
  const tipo = elemento('selectTipoVehiculo')?.value || 'auto';
  const placa = elemento('inputPlacaVehiculo')?.value.trim() || '';
  crearVehiculo(indice, direccion, false, tipo, placa);
}

function configurarControles() {
  elemento('btnPausarSpawn')?.addEventListener('click', (evento) => {
    spawnPausado = !spawnPausado;
    evento.currentTarget.textContent = spawnPausado ? '▶️ Reanudar Generación de Autos' : '⏸️ Pausar Generación de Autos';
  });
  elemento('btnOlaVerde')?.addEventListener('click', () => {
    olaVerdeActiva = true;
    intersecciones.forEach((interseccion, i) => setTimeout(() => {
      if (olaVerdeActiva) cambiarAPar(interseccion, 'EW', 10);
    }, i * 700));
  });
  elemento('btnDesactivarOla')?.addEventListener('click', () => { olaVerdeActiva = false; });
  elemento('btnModoNocturno')?.addEventListener('click', (evento) => {
    const activo = !document.body.classList.contains('modo-nocturno');
    document.body.classList.toggle('modo-nocturno', activo);
    intersecciones.forEach((interseccion) => { interseccion.modoNocturno = activo; });
    evento.currentTarget.textContent = activo ? '☀️ Desactivar Modo Nocturno' : '🌙 Activar Modo Nocturno';
  });
  elemento('btnAmbulancia')?.addEventListener('click', () => {
    const indice = Math.floor(Math.random() * NUM_NODOS);
    const direccion = DIRECCIONES[Math.floor(Math.random() * DIRECCIONES.length)];

    actualizarEstadoAmbulancia(`🚑 Ambulancia desplegada desde Intersección ${indice + 1}. Calculando ruta...`, 0);
    crearVehiculo(indice, direccion, true);
  });
  elemento('btnInyectarVehiculos')?.addEventListener('click', inyectarVehiculos);
  elemento('selectEntradaVehiculo')?.addEventListener('change', actualizarRutaManual);
  actualizarRutaManual();
  elemento('btnAgregarPeaton')?.addEventListener('click', () => {
    const indice = Number(elemento('selectPeatonNodo')?.value);
    const lado = elemento('selectPeatonLado')?.value;
    solicitarPeaton(indice, lado);
  });
  elemento('btnSimularIncidente')?.addEventListener('click', () => {
    const indice = Number(elemento('selectIncidenteNodo')?.value ?? 0);
    activarIncidente(indice, 'manual');
  });
  elemento('btnDespejarIncidentes')?.addEventListener('click', despejarTodosLosIncidentes);
}

function conectarMqtt() {
  if (!window.mqtt) return;
  const cliente = window.mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
    clientId: `WebClient-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 3000,
  });

  cliente.on('connect', () => cliente.subscribe('lomasdelcacique-unah-2026/fase3/sensor/#'));

  cliente.on('message', (tema, mensaje) => {
    const texto = mensaje.toString();

    if (tema.endsWith('/distancia-este')) {
      const distancia = Number(texto);
      const porcentaje = Math.max(0, Math.min(100, 100 - ((distancia - 5) / 145) * 100));
      elemento('barra-proximidad').style.width = `${porcentaje}%`;
      elemento('txtProximidad').textContent = `Auto a: ${distancia} cm`;
      actualizarBarraProximidad(distancia);
      if (distancia < 20) crearVehiculo(0, 'este');

    } else if (tema.endsWith('/ambulancia')) {
      const indiceRandom = Math.floor(Math.random() * NUM_NODOS);
      const direccionRandom = DIRECCIONES[Math.floor(Math.random() * DIRECCIONES.length)];

      registrarEventoLog("Señal RFID (ESP32) recibida", "hardware");
      registrarEventoLog("Ambulancia (SENSOR RFID) desplegada", "ambulancia-rfid");
      
      actualizarEstadoAmbulancia("🚑 Ambulancia detectada por sensor RFID (ESP32)");

      crearVehiculo(indiceRandom, direccionRandom, true);

      if (vehiculos.length > 0) {
        vehiculos[vehiculos.length - 1].esRfid = true;
      }

      setTimeout(() => {
        // CORRECCIÓN: Cambiamos nombreOrigen (que no existía) por Intersección ${indiceRandom + 1}
        actualizarEstadoAmbulancia(
          `🚑 Ambulancia (SENSOR RFID) saliendo hacia el ${direccionRandom.toUpperCase()} (Intersección ${indiceRandom + 1})`, 
          5000
        );
      }, 3000);
    }else if (tema.endsWith('/este') && !tema.endsWith('/norte-este')) {
      crearVehiculo(0, 'este');

    } else if (tema.endsWith('/oeste')) {
      crearVehiculo(0, 'oeste');

    } else if (tema.endsWith('/norte-int1')) {
      crearVehiculo(0, 'sur');   // "sur" = entra desde el norte, baja hacia el sur

    } else if (tema.endsWith('/sur-int1')) {
      crearVehiculo(0, 'norte'); // "norte" = entra desde el sur, sube hacia el norte

    } else if (tema.endsWith('/incidente')) {
      // Wokwi/ESP32 puede publicar el número de intersección (1-8) o
      // "aleatorio" para simular un choque en un punto al azar.
      const valor = texto.trim().toLowerCase();
      const indice = (valor === 'aleatorio' || valor === '')
        ? Math.floor(Math.random() * NUM_NODOS)
        : Math.max(0, Math.min(NUM_NODOS - 1, Number(valor) - 1));
      activarIncidente(Number.isFinite(indice) ? indice : 0, 'Wokwi/ESP32');

    } else if (tema.endsWith('/incidente-limpiar')) {
      despejarTodosLosIncidentes();
    }
  });
}

function cicloSemaforos() {
  const colasPorDireccion = medirColasPorDireccion();
  intersecciones.forEach((interseccion) => {
    interseccion.colaPorDireccion = colasPorDireccion[interseccion.indice];
    avanzarCiclo(interseccion);
  });
  actualizarPeatones();
  actualizarPaneles();
}

function cicloVehiculos() {
  actualizarVehiculos();
  actualizarEmergenciasEnRuta();
  actualizarSensores();
  pintarVehiculos();
  actualizarPaneles();
}

crearPaneles();
configurarControles();
asegurarVisibilidadSemaforos();
crearSensoresVisuales();
intersecciones.forEach(aplicarSemaforos);
actualizarPaneles();
actualizarResumenIncidentes();
registrarEventoIncidente('🟢 Sistema de coordinación entre semáforos (Fase 3) listo.', 'info');
conectarMqtt();

setInterval(cicloSemaforos, 1000);
setInterval(cicloVehiculos, INTERVALO_MOVIMIENTO_MS);
setInterval(registrarMuestra, 5000);
setInterval(() => {
  if (!spawnPausado) crearVehiculo(Math.floor(Math.random() * NUM_NODOS), DIRECCIONES[Math.floor(Math.random() * DIRECCIONES.length)]);
}, 3000);
