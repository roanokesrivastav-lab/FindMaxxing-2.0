package core;

import edu.princeton.cs.algs4.StdDraw;
import edu.princeton.cs.algs4.WeightedQuickUnionUF;
import tileengine.TERenderer;
import tileengine.TETile;
import tileengine.Tileset;

import java.awt.*;
import java.util.HashMap;
import java.util.Random;

public class Main {
    private static final int WIDTH = 100;
    private static final int HEIGHT = 50;

    private static final long SEED = 0;
    private static final Random RANDOM = new Random(SEED);
    private static int spaceThreshold;
    private static HashMap<Integer, int[]> rooms;
    private WeightedQuickUnionUF roomConnections;

    /**
     * ronak fill these comments in
     * @param tiles
     */
    public static void generateRooms(TETile[][] tiles) {
        int spaceOccupied = 0;
        while (spaceOccupied < spaceThreshold){
            int leftcornerX = RANDOM.nextInt(WIDTH);
            int leftcornerY = RANDOM.nextInt(HEIGHT);
            int width = RANDOM.nextInt(4) + 5;
            int height = RANDOM.nextInt(4) + 5;
            if (roomIsValid(tiles,leftcornerX,leftcornerY,width,height)){
                fillRoom(tiles,leftcornerX,leftcornerY,width,height);
                spaceOccupied += width * height;
                int[] roomAttributes = new int[4];
                roomAttributes[0] = leftcornerX;
                roomAttributes[1] = leftcornerY;
                roomAttributes[2] = width;
                roomAttributes[3] = height;
                rooms.put(rooms.size(), roomAttributes);
            }
            System.out.println(TETile.toString(tiles));
        }
    }

    /**
     * ronak fill in the room w the tiles
     * @param tiles
     */
    private static void fillRoom(TETile[][] tiles, int leftcornerX, int leftcornerY, int width, int height) {
        for (int i = leftcornerX; i < leftcornerX + width; i++) {
            for (int j = leftcornerY; j < leftcornerY + height; j++) {
                if (i == leftcornerX || j == leftcornerY || i == leftcornerX + width - 1 || j == leftcornerY + height - 1) {
                    tiles[i][j] = Tileset.WALL;
                } else {
                    tiles[i][j] = Tileset.FLOOR;
                }
            }
        }

    }

    /**
     * check if potential room is valid
     * @param tiles
     */
    private static boolean roomIsValid(TETile[][] tiles, int leftcornerX, int leftcornerY, int width, int height){
        if (leftcornerX + width >= WIDTH){
            return false;
        }
        if (leftcornerY + height >= HEIGHT){
            return false;
        }
        for (int i = leftcornerX; i < leftcornerX + width + 1; i++) {
            for (int j = leftcornerY; j < leftcornerY+height + 1; j++) {
                if (tiles[i][j] != Tileset.NOTHING) {
                    return false;
                }
            }
            }
        return true;
    }
    public static void connectRooms(TETile[][] tiles){
        return;
    }
    /** Picks a RANDOM tile with a 33% change of being
     *  a wall, 33% chance of being a flower, and 33%
     *  chance of being empty space.
     */
    private static TETile randomTile() {
        // The following call to nextInt() uses a bound of 3 (this is not a seed!) so
        // the result is bounded between 0, inclusive, and 3, exclusive. (0, 1, or 2)
        int tileNum = RANDOM.nextInt(3);
        return switch (tileNum) {
            case 0 -> Tileset.WALL;
            case 1 -> Tileset.FLOWER;
            default -> Tileset.NOTHING;
        };
    }
    private static void fillWorldWithNothing(TETile[][] tiles) {
        for (int i = 0; i < WIDTH; i++) {
            for (int j = 0; j < HEIGHT; j++) {
                tiles[i][j] = Tileset.NOTHING;
            }
        }
    }

    public static void main(String[] args) {
        TERenderer ter = new TERenderer();
        ter.initialize(WIDTH, HEIGHT);
        spaceThreshold = (int)(((double)(RANDOM.nextInt(50) + 10)/100) * (WIDTH * HEIGHT));
        rooms = new HashMap<>();
        TETile[][] randomTiles = new TETile[WIDTH][HEIGHT];
        fillWorldWithNothing(randomTiles);
        generateRooms(randomTiles);

        StdDraw.clear(new Color(0, 0, 0));
        ter.drawTiles(randomTiles);
        StdDraw.show();
    }

}
