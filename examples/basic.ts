import { execute } from "../src/sandbox";

console.log(await execute("return 1 + 2;"));
console.log(await execute('throw new Error("An example failure");'));
