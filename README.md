# Better Inventory, Search and selling For treinta.co
## Mejorar inventario, busqueda y venta para treinta.co

Ya que los programadores de ese sitio web son basura, he creado un script para que el inventario con mas de 2000 items sea cargado en cache; para que las busquedas sean instantaneas sin necesidad de llamar a la Api de AWS, el cual carga el inventario por cada busqueda, tambien mejoré la busqueda por palabra ya que si colocabas 2 palabras los buscaba como 2 items separados por coma. añadidos atajos para borrar rapido y sistema para venta rapida con Enter (pad numérico) e imprimir y venta rapida con la tecla + (pad numérico)

la finalidad de este script es mejorar el flujo de trabajo ya que antes de una actualizacion el sistema funcionaba perfecto pero los programadores añaden una funcion que rompe las demás y el sistema y la atencion al cliente lo unico que te dicen es que "borres cache"

### Descargo de responsabilidad: 
Estos scripts son herramientas no oficiales desarrolladas para uso personal con Tampermonkey y no están afiliados, respaldados ni garantizados por Treinta. Su funcionamiento depende de la estructura y los servicios actuales de la plataforma, por lo que puede dejar de funcionar si Treinta modifica su interfaz, API o flujo de ventas. Los atajos automáticos pueden ejecutar ventas reales en el backend; el usuario es responsable de verificar la canasta, los productos, los precios y la modalidad de venta antes de activar cualquier acción. El caché local puede contener información desactualizada temporalmente. El uso de estos scripts se realiza bajo responsabilidad exclusiva del usuario y se recomienda probarlos primero en un entorno controlado.

Userscripts para [Tampermonkey](https://www.tampermonkey.net/) que aceleran el flujo de ventas en [Treinta](https://web.treinta.co/new-sale):

1. [`Inventario rapido - cache local.user.js`](./Inventario%20rapido%20-%20cache%20local.user.js) — guarda el inventario localmente y sirve las búsquedas desde memoria.
2. [`Auto-confirmar.js`](./Auto-confirmar.js) — automatiza la confirmación y el pago mediante el teclado numérico.

Ambos scripts son independientes, no requieren librerías externas y funcionan sobre la ruta `https://web.treinta.co/new-sale*`.

> Importante: las teclas de venta ejecutan acciones reales en la cuenta de Treinta. Verifica siempre la canasta antes de usar los atajos automáticos.

## Instalación

1. Instala Tampermonkey en el navegador.
2. Abre el panel de Tampermonkey y crea un script nuevo para cada archivo.
3. Copia el contenido de cada archivo sin mezclar los dos scripts.
4. Guarda los scripts y recarga `new-sale`.
5. Abre la página de nueva venta y espera a que el indicador muestre `Caché listo: N productos`.

Versiones documentadas:

| Script | Versión | Función |
|---|---:|---|
| Inventario rápido | 1.0.7 | Caché local y búsqueda instantánea |
| Auto-confirmar | 2.0.2 | Confirmación automática de ventas |

## Inventario rápido: lógica del caché

### 1. Interceptación de las solicitudes

El script se ejecuta en `document-start`, antes de que cargue la aplicación de Treinta. Guarda referencias a las implementaciones originales de `XMLHttpRequest` y `fetch`, y las intercepta para reconocer el endpoint de inventario:

```text
https://web-api-gateway.treinta.co/manager/<storeId>/products/summary-with-taxes
```

Cuando Treinta realiza una solicitud de inventario sin búsqueda, el script:

- identifica la tienda;
- conserva en memoria los encabezados de autenticación necesarios;
- guarda la página recibida;
- registra el total de productos y el tamaño de página;
- inicia una sincronización completa en segundo plano si faltan páginas o el caché expiró.

Los encabezados de autenticación solo se mantienen en memoria durante la sesión. No se guardan en IndexedDB.

### 2. Almacenamiento local

Utiliza IndexedDB con la base:

```text
treinta-local-inventory-cache
```

La base contiene dos almacenes:

- `meta`: tienda, total, páginas cargadas, tamaño de página y fecha de la última sincronización completa.
- `products`: productos individuales indexados por tienda. La clave es `storeId:productId`.

La configuración principal es:

- 50 productos por página.
- 4 solicitudes simultáneas durante la reconstrucción.
- Sincronización completa cada 10 minutos como máximo, además de las actualizaciones provocadas por cambios en Treinta.

### 3. Reconstrucción completa

La función `fullSync()` toma la URL y el contexto de la última respuesta válida, calcula el número total de páginas y las descarga con cuatro trabajadores concurrentes. Cada página se fusiona con el caché y se persiste en IndexedDB.

Al terminar, el script elimina productos que ya no aparecieron en la respuesta completa y marca el caché como listo.

Si una venta u otra operación modifica datos en Treinta, el script programa una nueva sincronización después de 1,5 segundos. La copia anterior sigue disponible mientras se actualiza; no se desactiva la búsqueda durante ese proceso.

### 4. Búsqueda local

Cuando el caché está completo y la solicitud es una búsqueda simple, el script no llama al backend. En su lugar:

1. obtiene todos los productos de la memoria;
2. normaliza mayúsculas, minúsculas y acentos;
3. busca los términos en nombre, SKU, categoría y notas;
4. ordena los resultados por relevancia;
5. devuelve una respuesta con el mismo formato que espera Treinta.

La clasificación prioriza, en este orden aproximado:

- nombre exactamente igual a la búsqueda;
- nombre que comienza con todos los términos;
- frase completa dentro del nombre;
- todos los términos presentes en el nombre;
- coincidencias parciales en nombre, SKU, categoría o notas.

Por ejemplo, `Papel Regalo` queda antes que `caja regalo` al buscar `papel regalo`, aunque esta última pueda coincidir por su categoría o notas.

Para mantener la compatibilidad con Treinta, la respuesta local simula los eventos de `XMLHttpRequest` (`readystatechange`, `load` y `loadend`) y devuelve los campos `data`, `limit`, `page` y `total`.

### 5. Eliminación y actualización del caché

El script añade tres controles encima de `Cerrar sesión` en el menú lateral:

- **N productos**: indicador visual del tamaño del caché.
- **Borrar caché**: limpia los almacenes locales y reconstruye el inventario desde cero.
- **Actualizar**: descarga nuevamente el inventario sin borrar primero la copia disponible.

## Atajos del inventario

Estos atajos pertenecen a `Inventario rapido - cache local.user.js`:

| Tecla | Acción |
|---|---|
| `Backspace` fuera de un campo editable | Limpia la búsqueda y devuelve el foco al buscador. |
| `Backspace` dentro de un campo editable | Comportamiento normal. |
| `Enter` en el buscador | Quita el foco del buscador. |
| `1` a `9` | Selecciona el producto visible según su posición. |
| `0` | Selecciona el décimo producto visible. |

Los atajos numéricos solo funcionan cuando no se está editando texto, cantidades, precios u otro campo editable. El orden utilizado es el orden actual de las tarjetas visibles en Treinta, incluyendo la búsqueda y el ordenamiento seleccionado.

Además, mientras el caché está completo, el script reduce el debounce de búsqueda de Treinta únicamente cuando se acaba de escribir en el buscador. Los temporizadores normales de la aplicación no se modifican.

## Auto-confirmar: lógica de las ventas

`Auto-confirmar.js` usa los `data-testid` de los botones de Treinta para no depender del texto visible o de posiciones en pantalla:

```text
basketButton_default
balance_sale_button_confirm
balance_sale_button_print_ticket
calculator-modal__confirm-button
balanceSale_button_newSale
```

### Espera de botones

En vez de usar varios tiempos fijos, `waitForButton()`:

- comprueba primero si el botón ya está disponible;
- observa temporalmente los cambios del DOM;
- ignora botones ocultos o deshabilitados;
- continúa inmediatamente cuando aparece el botón correcto;
- desconecta su `MutationObserver` al resolver o al vencer el tiempo máximo.

Esto evita observar permanentemente todo el documento y evita que una venta se ejecute varias veces mediante una bandera `saleInProgress`.

### Venta rápida sin factura

Con `NumpadEnter`:

```text
Continuar → Crear venta → Confirmar pago → esperar finalización → Escape
```

No se añade el retraso de la impresora en este flujo.

### Venta con factura

Con `NumpadAdd` (`+` del teclado numérico):

```text
Continuar → esperar 600 ms → Imprimir factura/ticket
         → Crear venta → Confirmar pago → esperar finalización → Escape
```

Los 600 ms son intencionales y solo se aplican después de abrir la canasta y antes de pulsar el botón de impresión. Treinta necesita ese tiempo para inicializar la impresora; si se elimina, puede mostrar que no hay impresoras.

### Cierre del aviso final

Después de confirmar el pago, el script espera a que aparezca `balanceSale_button_newSale`, que indica que la venta terminó y que Treinta mostró el cuadro final. En ese momento despacha `Escape` para cerrarlo.

La tecla `F1` conserva el flujo para continuar una venta con factura cuando la venta ya está abierta y el botón de impresión está disponible. En ese caso no aplica el retraso de 600 ms porque la canasta ya está abierta.

## Compatibilidad entre ambos scripts

Los dos scripts pueden estar activos al mismo tiempo:

- el script de inventario intercepta únicamente solicitudes de consulta de productos y maneja sus propios atajos;
- el script de ventas actúa sobre teclas del teclado numérico y botones de confirmación;
- los campos editables quedan protegidos para evitar ventas accidentales mientras se escribe una cantidad, precio o búsqueda.



